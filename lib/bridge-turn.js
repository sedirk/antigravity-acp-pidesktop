'use strict';

/**
 * 桥接轮次的共享核心：会话/挂起/回填/续流，一次实现，两个通道复用。
 *
 * 通道差异全部收敛到 adapter：
 *   begin()            本轮开始（写首帧）
 *   text(piece)        正文增量
 *   thought(piece)     思考增量
 *   park(toolCall)     把运行时请求的工具交给宿主执行（Chat: tool_calls / Responses: function_call）
 *   finish()           正常收尾
 *   error(err)         失败收尾（保留已输出内容）
 *   end()              关闭流
 *
 * 适配器只负责“怎么把一件事说给宿主听”，不关心状态机。
 */

/**
 * @param {object} deps 网关内部能力
 * @param {Map} deps.bridges 会话键 → 桥接状态
 * @param {() => Promise<string>} deps.ensureBridgeServer 回环 MCP 地址
 * @param {Function} deps.sessionFor
 * @param {Function} deps.prompt
 * @param {Function} deps.policyForRequest
 * @param {Function} deps.usageFor
 * @param {Function} deps.log
 * @param {object} deps.acp
 * @param {Function} deps.projectTools
 */
function createBridgeTurn(deps) {
  const {
    bridges, ensureBridgeServer, ensureRuntime, sessionFor, prompt, policyForRequest,
    usageFor, log, acp, projectTools, flatten, getConfig, lastUserImages, lastUserDocs,
    seedSessionStats, waitPromptIdle, isSessionBusy,
  } = deps;
  const BUILTIN = require('./config.js').BUILTIN_BRIDGE_GUIDANCE;
  const COALESCE_MS = 20;

  /** 提示层引导：让模型优先用桥接工具。 */
  function guidanceFor(tools) {
    const names = (tools || []).map((t) => `pi-bridge_${t.name}`);
    if (!names.length) return '';
    // 面板里可覆盖（config.bridgeGuidance），支持 {tools} 占位；留空用内置文案
    const custom = String((typeof getConfig === 'function' && getConfig().bridgeGuidance) || '').trim() || BUILTIN;
    return custom.replaceAll('{tools}', names.join('、')) + '\n\n';
  }

  function lastUserText(messages) {
    const found = [...messages].reverse().find((m) => m.role === 'user');
    return String((found && found.content) || '');
  }

  function incrementalPrompt(messages, formatToolResult) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return '';
    const base = String(messages[lastUserIdx].content || '');
    if (lastUserIdx === messages.length - 1) return base;
    const trailingTools = [];
    for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
      const m = messages[i];
      if (m && m.role === 'tool') {
        const out = typeof formatToolResult === 'function' ? formatToolResult(m) : String(m.content || '');
        if (out) trailingTools.push(out);
      }
    }
    if (trailingTools.length === 0) return base;
    return `${base}\n\n[宿主已完成工具执行结果]\n${trailingTools.join('\n---\n')}`;
  }

  function clearParked(bridge, reason = '对话已中断或被新消息替代') {
    if (!bridge) return;
    if (bridge.parkTimer) { clearTimeout(bridge.parkTimer); bridge.parkTimer = null; }
    const list = Array.isArray(bridge.parked) ? bridge.parked.splice(0) : [];
    for (const item of list) {
      try { item.resolve({ content: [{ type: 'text', text: reason }], isError: true }); } catch { /* ignore */ }
    }
  }

  function isNewUserTurn(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    return Boolean(last && last.role === 'user');
  }

  /**
   * 执行一轮（可能因工具调用而挂起；下一轮请求会带结果回来）。
   * @returns {Promise<'done'|'paused'|'error'>}
   */
  async function run({ key, req, messages, stats, cfg, model, effort, adapter, matchToolResult, toolResultText }) {
    const url = await ensureBridgeServer();
    // 每个对话一个带键的端点：MCP 请求回来时靠它定位到正确的桥接状态
    const bridgeUrl = `${url}?k=${encodeURIComponent(key)}`;

    const tools = projectTools(req.tools);
    let bridge = bridges.get(key);
    if (!bridge) {
      bridge = { parked: [], parkTimer: null, waiting: true, tools, sessionId: null, lastText: '', gen: 0, activeStats: null };
      bridges.set(key, bridge);
    }
    if (!Array.isArray(bridge.parked)) bridge.parked = bridge.parked ? [bridge.parked] : [];
    bridge.tools = tools;
    bridge.adapter = adapter;
    if (typeof seedSessionStats === 'function') seedSessionStats(key, stats);
    const currentStats = () => {
      if (typeof seedSessionStats === 'function') seedSessionStats(key, stats);
      if (bridge.activeStats) {
        if (Number.isFinite(bridge.activeStats.contextUsed) && bridge.activeStats.contextUsed > 0) stats.contextUsed = bridge.activeStats.contextUsed;
        if (Number.isFinite(bridge.activeStats.contextSize) && bridge.activeStats.contextSize > 0) stats.contextSize = bridge.activeStats.contextSize;
      }
      return stats;
    };
    // 挂起期间运行时在等宿主执行工具，看门狗必须知道（否则 180 秒的等待会被当成卡死）
    stats.parked = () => Array.isArray(bridge.parked) && bridge.parked.length > 0;
    let settle;
    let finished = false;
    const roundDone = new Promise((resolve) => { settle = resolve; });
    const closeRound = (reason) => { if (!finished) { finished = true; settle(reason); } };
    const prevCloseRound = bridge.closeRound;
    bridge.closeRound = closeRound;

    adapter.begin();

    if (isNewUserTurn(messages)) {
      const isBusy = Boolean(
        bridge.running ||
        (Array.isArray(bridge.parked) && bridge.parked.length > 0) ||
        (bridge.sessionId && typeof isSessionBusy === 'function' && isSessionBusy(bridge.sessionId))
      );
      if (isBusy) {
        log(`桥接：检测到用户轮中补充或改变方向（Steering），中断上一轮生成并切换到最新输入（对话 ${String(key).slice(0, 12)}）`);
        bridge.gen = (bridge.gen || 0) + 1;
        clearParked(bridge, '用户在轮中补充或改变方向');
        if (bridge.running && typeof prevCloseRound === 'function') {
          try { prevCloseRound('steered'); } catch { /* ignore */ }
        }
        bridge.running = false;
        if (bridge.sessionId) {
          const targetSid = bridge.sessionId;
          try { acp.notify('session/cancel', { sessionId: targetSid }); } catch { /* ignore */ }
          if (typeof waitPromptIdle === 'function') {
            await waitPromptIdle(targetSid, '用户轮中改变方向', 1500);
          } else {
            try { if (typeof acp.abandon === 'function') acp.abandon('session/prompt', '用户轮中改变方向', targetSid); } catch { /* ignore */ }
          }
        }
      }
    }

    const flushPark = () => {
      bridge.parkTimer = null;
      if (!bridge.parked || bridge.parked.length === 0) return;
      // 挂起前先把这一轮已经产生的叙述发出去，否则用户只看到工具调用
      const pendingText = bridge.lastText || '';
      const names = bridge.parked.map((p) => p.name).join(',');
      current().park(bridge.parked, usageFor(bridge.lastPrompt || '', pendingText, '', currentStats()), pendingText);
      bridge.lastText = '';
      log(`桥接：运行时请求工具 ${names}（对话 ${String(key).slice(0, 12)}，共 ${bridge.parked.length} 个，已随附正文 ${pendingText.length} 字）→ 交给宿主执行`);
      stats.parkedName = names;
      closeRound('paused');
    };

    bridge.onPark = () => {
      if (!bridge.parked || bridge.parked.length === 0 || finished) return;
      if (bridge.parkTimer) return;
      // 微批窗口（20ms）：模型同一拍发出多个并行 tools/call 时，合并成同一轮 tool_calls 返回宿主
      bridge.parkTimer = setTimeout(flushPark, COALESCE_MS);
      bridge.parkTimer.unref?.();
    };

    // 续流是另一个 HTTP 请求：事件必须发给当前轮的 adapter，而不是发起这轮的那个
    const current = () => bridge.adapter || adapter;

    const runPrompt = async (promptText, myGen) => {
      const isCurrent = () => bridge.gen === myGen;
      if (typeof ensureRuntime === 'function') await ensureRuntime();
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await sessionFor(concreteModel, messages, req, [{ type: 'http', name: 'pi-bridge', url: bridgeUrl, headers: [] }]);
      bridge.sessionId = prepared.sessionId;
      if (stats.task) {
        stats.task.sessionId = prepared.sessionId;
        stats.task.active = true;
      }
      // 新会话必须带上完整上下文（system 提示、AGENTS.md 等都在里面）；续会话才只发增量
      if (!prepared.resume && typeof flatten === 'function') promptText = flatten(messages);
      const policy = policyForRequest(cfg.toolPolicy, req).policy;
      const images = typeof lastUserImages === 'function' ? lastUserImages(messages) : [];
      const docs = typeof lastUserDocs === 'function' ? lastUserDocs(messages) : [];
      bridge.activeStats = stats;
      try {
        await prompt(prepared.sessionId, guidanceFor(tools) + promptText, (u) => {
          if (!u || !isCurrent()) return;
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
            bridge.lastText = (bridge.lastText || '') + u.content.text;
            current().text(u.content.text, usageFor(bridge.lastPrompt || '', bridge.lastText, '', currentStats()));
            return;
          }
          if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
            current().thought(u.content.text);
          }
        }, images, docs, stats, policy);
        if (!isCurrent()) return;
        clearParked(bridge, '本轮已结束');
        current().finish(usageFor(bridge.lastPrompt || '', bridge.lastText || '', '', currentStats()), bridge.lastText || '');
        (bridge.closeRound || closeRound)('done');
      } finally {
        if (stats.task) stats.task.active = false;
        if (isCurrent()) bridge.running = false;
      }
    };

    let resumedFromPark = false;
    if (bridge.parked.length > 0) {
      const matched = [];
      const remaining = [];
      for (const item of bridge.parked) {
        const msg = matchToolResult(messages, item.toolCallId);
        if (msg) matched.push({ item, msg });
        else remaining.push(item);
      }
      const hasUserMsg = Array.isArray(messages) && messages.some((m) => m && m.role === 'user');
      if (matched.length === 0 && (isNewUserTurn(messages) || hasUserMsg)) {
        // 用户在宿主中断了上一轮工具执行并直接发了新消息或修改提问重新发送：取消旧挂起并开启新一轮，绝不死循环重发旧 tool_calls
        log(`桥接：检测到新的用户提问或修改重新对话，放弃上一轮未回填的 ${remaining.length} 个挂起工具调用`);
        bridge.gen = (bridge.gen || 0) + 1;
        clearParked(bridge, '用户已中断上一轮工具调用并开始新提问');
        if (bridge.sessionId) {
          const targetSid = bridge.sessionId;
          try { acp.notify('session/cancel', { sessionId: targetSid }); } catch { /* ignore */ }
          if (typeof waitPromptIdle === 'function') {
            await waitPromptIdle(targetSid, '用户已中断上一轮工具调用');
          } else {
            try { if (typeof acp.abandon === 'function') acp.abandon('session/prompt', '用户已中断上一轮工具调用', targetSid); } catch { /* ignore */ }
          }
        }
      } else if (matched.length === 0) {
        log(`桥接：没有找到 ${remaining.map((p) => p.toolCallId).join(',')} 的结果，重发工具调用`);
        current().park(remaining, usageFor('', '', '', currentStats()), bridge.lastText || '', true);
        adapter.end();
        return 'paused';
      } else {
        bridge.parked = remaining;
        for (const { item, msg } of matched) {
          const resultText = toolResultText(msg);
          item.resolve({ content: [{ type: 'text', text: resultText }] });
          log(`桥接：已回填工具结果（${item.name}，${resultText.length} 字）`);
        }
        if (remaining.length > 0) {
          // 批量工具调用只回填了一部分：把剩余未回填的继续挂给宿主执行
          current().park(remaining, usageFor('', '', '', currentStats()), '', true);
          adapter.end();
          return 'paused';
        }
        bridge.waiting = true;
        resumedFromPark = true;
      }
    }

    if (!resumedFromPark) {
      bridge.lastPrompt = incrementalPrompt(messages, toolResultText);
      bridge.lastText = '';
      bridge.waiting = true;
      bridge.running = true;
      const myGen = (bridge.gen = (bridge.gen || 0) + 1);
      runPrompt(bridge.lastPrompt, myGen).catch((error) => {
        if (bridge.gen !== myGen) return;
        bridge.running = false;
        clearParked(bridge, `桥接轮次失败：${String(error && error.message).slice(0, 120)}`);
        log(`桥接轮次失败：${String(error.message).slice(0, 160)}`);
        current().error(error, bridge.lastText || '');
        (bridge.closeRound || closeRound)('error');
      });
    }

    const reason = await roundDone;
    adapter.end();
    return reason;
  }

  return { run, guidanceFor, clearParked };
}

module.exports = { createBridgeTurn };
