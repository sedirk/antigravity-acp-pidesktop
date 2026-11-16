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
    promptImagesFor, promptDocsFor, retryContinuePrompt,
    seedSessionStats, waitPromptIdle, isSessionBusy,
    canCoalesceUserTurn, syncSessionUserTurn,
  } = deps;
  const BUILTIN = require('./config.js').BUILTIN_BRIDGE_GUIDANCE;
  const { summarizeToolSignatures } = require('./bridge.js');
  const COALESCE_MS = 32;
  const TASK_COALESCE_MS = 65;
  const MAX_COALESCE_MS = 180;
  const DEFAULT_CONTINUE_TEXT = retryContinuePrompt || '请继续完成上一条请求（若此前已执行部分步骤，请直接基于已有上下文与结果继续，无需重复开头）。';

  function sleepAbortableLocal(ms, shouldStop, registerAbort = null) {
    if (typeof shouldStop === 'function' && shouldStop()) return Promise.resolve(false);
    if (!ms || ms <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let unregister = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (typeof unregister === 'function') {
          try { unregister(); } catch { /* ignore */ }
        }
        resolve(ok);
      };
      const start = Date.now();
      const timer = setInterval(() => {
        if (typeof shouldStop === 'function' && shouldStop()) {
          finish(false);
          return;
        }
        if (Date.now() - start >= ms) {
          finish(true);
        }
      }, Math.min(100, Math.max(15, Math.floor(ms / 4))));
      timer.unref?.();
      if (typeof registerAbort === 'function') {
        unregister = registerAbort(() => finish(false));
      }
    });
  }

  /**
   * 提示层引导：让模型优先用桥接工具。
   * 前缀缓存对齐（Prefix Cache Alignment）：
   * 对工具列表进行稳定字母排序并统一使用 \n 换行，确保跨请求字节级一致，最大化复用 TPU KV Cache。
   */
  function guidanceFor(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const sorted = [...tools].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const names = sorted.map((t) => `pi-bridge_${t.name}`);
    if (!names.length) return '';
    const rawCustom = String((typeof getConfig === 'function' && getConfig().bridgeGuidance) || '').trim();
    const isDefaultGuidance = !rawCustom || rawCustom === BUILTIN;
    const custom = rawCustom || BUILTIN;
    const rendered = custom.replaceAll('{tools}', names.join('、')).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!rendered) return '';
    const sigSummary = isDefaultGuidance ? summarizeToolSignatures(sorted) : '';
    return sigSummary ? `${rendered}\n${sigSummary}\n\n` : `${rendered}\n\n`;
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
    if (list.length > 0) {
      bridge.lastClearedToolIds = new Set(list.map((it) => String((it && it.toolCallId) || '')).filter(Boolean));
      bridge.lastClearedTools = new Map(
        list
          .filter((it) => it && it.toolCallId)
          .map((it) => [String(it.toolCallId), String(it.rawName || it.name || 'tool')])
      );
    }
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
      bridge = { parked: [], parkTimer: null, waiting: true, tools, sessionId: null, lastText: '', gen: 0, activeStats: null, currentTask: null, abortListeners: new Set(), toolBurstCount: 0, lastParkAt: 0 };
      bridges.set(key, bridge);
    }
    if (!Array.isArray(bridge.parked)) bridge.parked = bridge.parked ? [bridge.parked] : [];
    if (!(bridge.abortListeners instanceof Set)) bridge.abortListeners = new Set();
    if (!(bridge.openRounds instanceof Set)) bridge.openRounds = new Set();
    const notifyBridgeAbort = () => {
      for (const fn of [...bridge.abortListeners]) {
        try { fn(); } catch { /* ignore */ }
      }
    };
    bridge.abortCooldown = notifyBridgeAbort;
    const myReqSeq = (bridge.reqSeq = (bridge.reqSeq || 0) + 1);
    const isLatestReq = () => bridge.reqSeq === myReqSeq;
    bridge.tools = tools;
    bridge.adapter = adapter;
    if (typeof seedSessionStats === 'function') seedSessionStats(key, stats);
    if (stats.task) {
      if (!stats.task.sessionId && bridge.sessionId) stats.task.sessionId = bridge.sessionId;
      stats.task.active = true;
    }
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
    const roundEntry = {
      seq: myReqSeq,
      close: (reason) => {
        if (!finished) {
          finished = true;
          bridge.openRounds.delete(roundEntry);
          settle(reason);
        }
      },
    };
    bridge.openRounds.add(roundEntry);
    const closeRound = roundEntry.close;
    bridge.closeRound = closeRound;
    const supersedeOlderRounds = (reason = 'steered') => {
      for (const entry of [...bridge.openRounds]) {
        if (entry.seq < myReqSeq) {
          try { entry.close(reason); } catch { /* ignore */ }
        }
      }
    };
    adapter.begin();
    const modelKey = `${model || ''}::${effort || ''}`;
    let coalescedUserNote = '';
    let cancelledMatchedOutputs = [];
    let preMatched = null;

    if (bridge.parked.length > 0) {
      const matched = [];
      const remaining = [];
      let lastMatchedIdx = -1;
      for (const item of bridge.parked) {
        let matchedMsg = null;
        let matchedIdx = -1;
        if (Array.isArray(messages)) {
          for (let i = 0; i < messages.length; i += 1) {
            const m = messages[i];
            if (!m || m.role !== 'tool') continue;
            const tid = m.tool_call_id || m.toolCallId || '';
            if (String(tid) === String(item.toolCallId)) {
              matchedMsg = m;
              matchedIdx = i;
              break;
            }
          }
        }
        if (!matchedMsg && typeof matchToolResult === 'function') {
          matchedMsg = matchToolResult(messages, item.toolCallId);
        }
        if (matchedMsg) {
          matched.push({ item, msg: matchedMsg });
          if (matchedIdx > lastMatchedIdx) lastMatchedIdx = matchedIdx;
        } else {
          remaining.push(item);
        }
      }
      preMatched = { matched, remaining, lastMatchedIdx };
      if (isNewUserTurn(messages)) {
        const trailingSlice = lastMatchedIdx >= 0 && Array.isArray(messages) ? messages.slice(lastMatchedIdx + 1) : messages;
        const sliceHasAttachments = Array.isArray(trailingSlice) && trailingSlice.some((m) => m && (
          (Array.isArray(m.images) && m.images.length > 0) ||
          (Array.isArray(m.documents) && m.documents.length > 0)
        ));
        const hasNewImages = sliceHasAttachments || (typeof lastUserImages === 'function' && lastUserImages(messages).length > 0);
        const hasNewDocs = sliceHasAttachments || (typeof lastUserDocs === 'function' && lastUserDocs(messages).length > 0);
        const canCoalesce =
          !bridge.resuming &&
          matched.length > 0 &&
          remaining.length === 0 &&
          !hasNewImages &&
          !hasNewDocs &&
          (!bridge.lastModelKey || bridge.lastModelKey === modelKey) &&
          (typeof canCoalesceUserTurn !== 'function' || canCoalesceUserTurn(key, messages, req));
        if (canCoalesce) {
          const trailingUsers = [];
          if (lastMatchedIdx >= 0 && Array.isArray(messages)) {
            for (let i = lastMatchedIdx + 1; i < messages.length; i += 1) {
              if (messages[i] && messages[i].role === 'user' && messages[i].content) {
                trailingUsers.push(String(messages[i].content));
              }
            }
          }
          if (trailingUsers.length === 0) {
            const fallbackUser = lastUserText(messages);
            if (fallbackUser) trailingUsers.push(fallbackUser);
          }
          coalescedUserNote = trailingUsers.join('\n\n').trim();
          log(`桥接：检测到挂起工具已有宿主结果且用户补充继续指令，合并回填至在途会话（零取消续推，对话 ${String(key).slice(0, 12)}）`);
        } else {
          if (matched.length > 0) {
            cancelledMatchedOutputs = matched.map(({ item, msg }) => `[${item.rawName || item.name}]\n${toolResultText(msg)}`);
          }
          log(`桥接：检测到用户新提问/修改分支，中断上一轮挂起工具并切换到最新输入（对话 ${String(key).slice(0, 12)}）`);
          bridge.gen = (bridge.gen || 0) + 1;
          notifyBridgeAbort();
          clearParked(bridge, '用户在轮中补充或改变方向');
          preMatched = null;
          supersedeOlderRounds('steered');
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
    } else if (isNewUserTurn(messages)) {
      if (bridge.lastClearedTools instanceof Map && bridge.lastClearedTools.size > 0 && Array.isArray(messages)) {
        for (const m of messages) {
          if (!m || m.role !== 'tool') continue;
          const tid = String(m.tool_call_id || m.toolCallId || '');
          if (tid && bridge.lastClearedTools.has(tid)) {
            cancelledMatchedOutputs.push(`[${bridge.lastClearedTools.get(tid)}]\n${toolResultText(m)}`);
          }
        }
        bridge.lastClearedTools = null;
      }
      const hasOlderOpenRound = [...bridge.openRounds].some((r) => r.seq < myReqSeq);
      const isBusy = Boolean(
        hasOlderOpenRound ||
        bridge.running ||
        (bridge.sessionId && typeof isSessionBusy === 'function' && isSessionBusy(bridge.sessionId))
      );
      if (isBusy) {
        log(`桥接：检测到用户轮中补充或改变方向（Steering），中断上一轮生成并切换到最新输入（对话 ${String(key).slice(0, 12)}）`);
        bridge.gen = (bridge.gen || 0) + 1;
        notifyBridgeAbort();
        clearParked(bridge, '用户在轮中补充或改变方向');
        supersedeOlderRounds('steered');
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
      bridge.lastParkAt = Date.now();
      // 挂起前先把这一轮已经产生的叙述发出去，否则用户只看到工具调用
      const pendingText = bridge.lastText || '';
      const names = bridge.parked.map((p) => p.name).join(',');
      current().park(bridge.parked, usageFor(bridge.lastPrompt || '', pendingText, '', currentStats()), pendingText);
      bridge.lastText = '';
      if (bridge.activeStats) {
        bridge.activeStats.legText = 0;
        bridge.activeStats.parkedName = names;
        if (bridge.activeStats.limiterLease && typeof bridge.activeStats.limiterLease.releaseForPark === 'function') {
          bridge.activeStats.limiterLease.releaseForPark();
        }
      }
      log(`桥接：运行时请求工具 ${names}（对话 ${String(key).slice(0, 12)}，共 ${bridge.parked.length} 个，已随附正文 ${pendingText.length} 字）→ 交给宿主执行`);
      stats.parkedName = names;
      closeRound('paused');
    };
    let parkBatchStart = 0;
    bridge.onPark = () => {
      if (!bridge.parked || bridge.parked.length === 0 || finished) return;
      const now = Date.now();
      if (!bridge.parkTimer) {
        parkBatchStart = now;
      } else {
        if (now - parkBatchStart >= MAX_COALESCE_MS) return;
        clearTimeout(bridge.parkTimer);
      }
      // 微批防抖窗口（普通工具 65ms，子代理 Task 并发派发 120ms，封顶 300ms）：合并运行时逐个派发的并行 tools/call
      const hasTaskCall = bridge.parked.some((p) => p && (p.name === 'Task' || p.rawName === 'Task'));
      const targetWindow = hasTaskCall ? TASK_COALESCE_MS : COALESCE_MS;
      const waitMs = Math.max(8, Math.min(targetWindow, MAX_COALESCE_MS - (now - parkBatchStart)));
      bridge.parkTimer = setTimeout(() => {
        parkBatchStart = 0;
        flushPark();
      }, waitMs);
      bridge.parkTimer.unref?.();
    };

    // 续流是另一个 HTTP 请求：事件必须发给当前轮的 adapter，而不是发起这轮的那个
    const current = () => bridge.adapter || adapter;

    const runPrompt = async (promptText, myGen) => {
      const isCurrent = () => bridge.gen === myGen;
      if (typeof ensureRuntime === 'function') await ensureRuntime();
      let concreteModel;
      let prepared;
      try {
        concreteModel = await acp.resolveModel(model, effort);
        prepared = await sessionFor(concreteModel, messages, req, [{ type: 'http', name: 'pi-bridge', url: bridgeUrl, headers: [] }]);
      } catch (prepErr) {
        // 模型发现未完成时 session/new 会先由 sessionFor 创建，随后在 sessionFor 内部由 session/new 补充 availableModels；
        // 如果 resolveModel 首次因模型发现未就绪推断了错误 ID 导致 switchModel 报错，重新 resolve 一次重试建连
        if (acp.discovery && acp.discovery.groups && acp.discovery.groups.size > 0) {
          concreteModel = await acp.resolveModel(model, effort);
          prepared = await sessionFor(concreteModel, messages, req, [{ type: 'http', name: 'pi-bridge', url: bridgeUrl, headers: [] }]);
        } else {
          throw prepErr;
        }
      }
      if (!isCurrent()) {
        throw Object.assign(new Error('Prompt superseded during session preparation'), { code: 'PROMPT_CANCELLED' });
      }
      bridge.sessionId = prepared.sessionId;
      bridge.currentTask = stats.task || null;
      if (prepared.turnSig) stats.turnSig = prepared.turnSig;
      if (Array.isArray(prepared.nextUserHistory)) stats.nextUserHistory = prepared.nextUserHistory;
      bridge.lastModelKey = modelKey;
      stats.parked = () => Array.isArray(bridge.parked) && bridge.parked.length > 0;
      stats.releaseOrphanedPark = (reason) => {
        if (!isCurrent()) return;
        const hadPendingParkTimer = Boolean(bridge.parkTimer);
        bridge.gen = (bridge.gen || 0) + 1;
        notifyBridgeAbort();
        clearParked(bridge, reason || '挂起等待宿主回填超时');
        bridge.running = false;
        if (hadPendingParkTimer && typeof bridge.closeRound === 'function') {
          try { bridge.closeRound('error'); } catch { /* ignore */ }
        }
      };
      stats.isCancelled = () => !isCurrent() || Boolean(bridge.currentTask && bridge.currentTask.cancelled);
      stats.registerAbort = (cb) => {
        bridge.abortListeners.add(cb);
        const taskOff = bridge.currentTask && typeof bridge.currentTask.onCancel === 'function'
          ? bridge.currentTask.onCancel(cb)
          : null;
        return () => {
          bridge.abortListeners.delete(cb);
          if (typeof taskOff === 'function') taskOff();
        };
      };
      if (stats.task) {
        stats.task.sessionId = prepared.sessionId;
        stats.task.active = true;
      }
      // 新会话必须带上完整上下文（system 提示、AGENTS.md 等都在里面）；续会话才只发增量
      if (!prepared.resume && typeof flatten === 'function') promptText = flatten(messages);
      else if (prepared.resume && prepared.deduplicatedRetry) promptText = DEFAULT_CONTINUE_TEXT;
      else if (prepared.resume) {
        if (cancelledMatchedOutputs.length > 0) {
          promptText = `[上一轮本地已执行但中断未回传的工具结果]\n${cancelledMatchedOutputs.join('\n---\n')}\n\n${promptText}`;
        }
      }
      const policy = policyForRequest(cfg.toolPolicy, req).policy;
      const images = typeof promptImagesFor === 'function'
        ? promptImagesFor(prepared, messages)
        : (typeof lastUserImages === 'function' ? lastUserImages(messages) : []);
      const docs = typeof promptDocsFor === 'function'
        ? promptDocsFor(prepared, messages)
        : (typeof lastUserDocs === 'function' ? lastUserDocs(messages) : []);
      bridge.activeStats = stats;
      try {
        // 前缀缓存对齐：首轮注入规范化工具引导词作为固定锚点；续会话（resume）时直接复用已有会话上下文，避免重复注入破坏前缀缓存
        const prefix = !prepared.resume ? guidanceFor(tools) : '';
        const fullPrompt = prefix ? (prefix + promptText) : promptText;
        await prompt(prepared.sessionId, fullPrompt, (u) => {
          if (!u || !isCurrent()) return;
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
            bridge.lastText = (bridge.lastText || '') + u.content.text;
            current().text(u.content.text, usageFor(bridge.lastPrompt || '', bridge.lastText, '', currentStats()));
            return;
          }
          if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
            current().thought(u.content.text);
            return;
          }
          if (u.sessionUpdate === 'gateway_keepalive') {
            if (typeof current().keepalive === 'function') current().keepalive(u.text || '');
            else if (u.text) current().thought(u.text);
          }
        }, images, docs, stats, policy, concreteModel);
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
      const matched = preMatched ? preMatched.matched : [];
      const remaining = preMatched ? preMatched.remaining : [];
      if (!preMatched) {
        for (const item of bridge.parked) {
          const msg = matchToolResult(messages, item.toolCallId);
          if (msg) matched.push({ item, msg });
          else remaining.push(item);
        }
      }
      const hasUserMsg = Array.isArray(messages) && messages.some((m) => m && m.role === 'user');
      if (matched.length === 0 && (isNewUserTurn(messages) || hasUserMsg)) {
        // 用户在宿主中断了上一轮工具执行并直接发了新消息或修改提问重新发送：取消旧挂起并开启新一轮，绝不死循环重发旧 tool_calls
        log(`桥接：检测到新的用户提问或修改重新对话，放弃上一轮未回填的 ${remaining.length} 个挂起工具调用`);
        bridge.gen = (bridge.gen || 0) + 1;
        notifyBridgeAbort();
        clearParked(bridge, '用户已中断上一轮工具调用并开始新提问');
        supersedeOlderRounds('steered');
        bridge.running = false;
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
        closeRound('paused');
        return 'paused';
      } else {
        if (coalescedUserNote && typeof syncSessionUserTurn === 'function') {
          try { syncSessionUserTurn(key, messages, req); } catch { /* ignore */ }
        }
        bridge.parked = remaining;
        if (bridge.activeStats) bridge.activeStats.legText = 0;
        const resumeGen = bridge.gen || 0;
        const activeCfg = (typeof getConfig === 'function' ? getConfig() : cfg) || {};
        const isResumeAborted = () => Boolean(stats.task?.cancelled) || (bridge.gen || 0) !== resumeGen;
        const registerResumeAbort = (cb) => {
          bridge.abortListeners.add(cb);
          const taskOff = stats.task && typeof stats.task.onCancel === 'function' ? stats.task.onCancel(cb) : null;
          return () => {
            bridge.abortListeners.delete(cb);
            if (typeof taskOff === 'function') taskOff();
          };
        };
        if (remaining.length === 0) {
          bridge.toolBurstCount = (bridge.toolBurstCount || 0) + 1;
          const throttleThreshold = Number(activeCfg.highContextThrottleTokens ?? 160000);
          const throttleMinMs = Number(activeCfg.highContextThrottleMs ?? 0);
          const curUsed = Number(currentStats().contextUsed || 0);
          if (throttleThreshold > 0 && throttleMinMs > 0 && curUsed >= throttleThreshold && bridge.toolBurstCount >= 4) {
            const delayMs = throttleMinMs;
            if (delayMs >= 150) {
              log(`桥接微节流：高上下文（${curUsed} tokens，连续第 ${bridge.toolBurstCount} 轮工具回填）平滑缓冲 ${delayMs}ms 以防瞬时 TPM 429`);
              await sleepAbortableLocal(delayMs, isResumeAborted, registerResumeAbort);
            }
          }
        }
        if (isResumeAborted()) {
          for (const { item } of matched) {
            try { item.resolve({ content: [{ type: 'text', text: '客户端断开连接（停止）' }], isError: true }); } catch { /* ignore */ }
          }
          if (stats.task) stats.task.active = false;
          if (stats.task?.cancelled) {
            bridge.gen = (bridge.gen || 0) + 1;
            notifyBridgeAbort();
            clearParked(bridge, '客户端断开连接（停止）');
            bridge.running = false;
            if (bridge.sessionId && activeCfg.cancelOnDisconnect !== false) {
              try { acp.notify('session/cancel', { sessionId: bridge.sessionId }); } catch { /* ignore */ }
            }
            adapter.end();
            closeRound('cancelled');
            return 'cancelled';
          }
          adapter.end();
          closeRound('cancelled');
          return 'cancelled';
        }
        for (let idx = 0; idx < matched.length; idx += 1) {
          const { item, msg } = matched[idx];
          let resultText = toolResultText(msg);
          if (coalescedUserNote && idx === matched.length - 1) {
            resultText = `${resultText}\n\n[宿主本轮因工具连续报错已暂停自动重试，用户补充最新指示继续执行]\n${coalescedUserNote}`;
          }
          item.resolve({ content: [{ type: 'text', text: resultText }] });
          log(`桥接：已回填工具结果（${item.name}，${resultText.length} 字${coalescedUserNote && idx === matched.length - 1 ? '，已合并用户续推指令' : ''}）`);
        }
        if (remaining.length > 0) {
          // 批量工具调用只回填了一部分：把剩余未回填的继续挂给宿主执行
          if (stats.task) stats.task.active = false;
          current().park(remaining, usageFor('', '', '', currentStats()), '', true);
          adapter.end();
          closeRound('paused');
          return 'paused';
        }
        bridge.adapter = adapter;
        bridge.closeRound = closeRound;
        bridge.waiting = true;
        resumedFromPark = true;
      }
    }

    if (!resumedFromPark) {
      if (!isLatestReq()) {
        closeRound('steered');
      } else if (stats.task?.cancelled) {
        closeRound('cancelled');
      } else {
        bridge.adapter = adapter;
        bridge.closeRound = closeRound;
        bridge.toolBurstCount = 0;
        bridge.lastPrompt = incrementalPrompt(messages, toolResultText);
        bridge.lastText = '';
        bridge.waiting = true;
        bridge.running = true;
        bridge.lastError = null;
        const myGen = (bridge.gen = (bridge.gen || 0) + 1);
        runPrompt(bridge.lastPrompt, myGen).catch((error) => {
          if (bridge.gen !== myGen) return;
          bridge.lastError = error;
          bridge.running = false;
          notifyBridgeAbort();
          clearParked(bridge, `桥接轮次失败：${String(error && error.message).slice(0, 120)}`);
          log(`桥接轮次失败：${String(error.message).slice(0, 160)}`);
          current().error(error, bridge.lastText || '');
          (bridge.closeRound || closeRound)('error');
        });
      }
    }

    try {
      const reason = await roundDone;
      if (reason === 'steered') {
        try { adapter.finish(usageFor(bridge.lastPrompt || '', '', '', currentStats()), ''); } catch { /* ignore */ }
      }
      adapter.end();
      return reason;
    } finally {
      bridge.openRounds.delete(roundEntry);
      if (stats.task) stats.task.active = false;
    }
  }

  return { run, guidanceFor, clearParked };
}

module.exports = { createBridgeTurn };
