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
  const { bridges, ensureBridgeServer, sessionFor, prompt, policyForRequest, usageFor, log, acp, projectTools, flatten, getConfig } = deps;
  const BUILTIN = require('./config.js').BUILTIN_BRIDGE_GUIDANCE;

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

  /**
   * 执行一轮（可能因工具调用而挂起；下一轮请求会带结果回来）。
   * @returns {Promise<'done'|'paused'|'error'>}
   */
  async function run({ key, req, messages, stats, cfg, model, effort, adapter, matchToolResult, toolResultText }) {
    const url = await ensureBridgeServer();
    const tools = projectTools(req.tools);

    let bridge = bridges.get(key);
    if (!bridge) {
      bridge = { parked: null, waiting: true, tools, sessionId: null, lastText: '' };
      bridges.set(key, bridge);
    }
    bridge.tools = tools;
    bridge.adapter = adapter;

    let settle;
    let finished = false;
    const roundDone = new Promise((resolve) => { settle = resolve; });
    const closeRound = (reason) => { if (!finished) { finished = true; settle(reason); } };
    bridge.closeRound = closeRound;

    adapter.begin();

    bridge.onPark = () => {
      if (!bridge.parked) return;
      // 挂起前先把这一轮已经产生的叙述发出去，否则用户只看到工具调用
      const pendingText = bridge.lastText || '';
      current().park(bridge.parked, usageFor(bridge.lastPrompt || '', pendingText, '', stats), pendingText);
      bridge.lastText = '';
      log(`桥接：运行时请求工具 ${bridge.parked.name}（已随附正文 ${pendingText.length} 字）→ 交给宿主执行`);
      closeRound('paused');
    };

    // 续流是另一个 HTTP 请求：事件必须发给当前轮的 adapter，而不是发起这轮的那个
    const current = () => bridge.adapter || adapter;

    const runPrompt = async (promptText) => {
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await sessionFor(concreteModel, messages, req, [{ type: 'http', name: 'pi-bridge', url, headers: [] }]);
      bridge.sessionId = prepared.sessionId;
      // 新会话必须带上完整上下文（system 提示、AGENTS.md 等都在里面）；续会话才只发增量
      if (!prepared.resume && typeof flatten === 'function') promptText = flatten(messages);
      const policy = policyForRequest(cfg.toolPolicy, req).policy;
      await prompt(prepared.sessionId, guidanceFor(tools) + promptText, (u) => {
        if (!u) return;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
          bridge.lastText = (bridge.lastText || '') + u.content.text;
          current().text(u.content.text, usageFor(bridge.lastPrompt || '', bridge.lastText, '', stats));
          return;
        }
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
          current().thought(u.content.text);
        }
      }, [], [], stats, policy);
      current().finish(usageFor(bridge.lastPrompt || '', bridge.lastText || '', '', stats), bridge.lastText || '');
      (bridge.closeRound || closeRound)('done');
    };

    if (bridge.parked) {
      const parked = bridge.parked;
      const resultMessage = matchToolResult(messages, parked.toolCallId);
      if (!resultMessage) {
        log(`桥接：没有找到 ${parked.toolCallId} 的结果，重发工具调用`);
        current().park(parked, usageFor('', '', '', stats), bridge.lastText || '', true);
        adapter.end();
        return 'paused';
      }
      const resultText = toolResultText(resultMessage);
      bridge.parked = null;
      bridge.waiting = true;
      parked.resolve({ content: [{ type: 'text', text: resultText }] });
      log(`桥接：已回填工具结果（${parked.name}，${resultText.length} 字）`);
    } else {
      bridge.lastPrompt = lastUserText(messages);
      bridge.lastText = '';
      bridge.waiting = true;
      runPrompt(bridge.lastPrompt).catch((error) => {
        log(`桥接轮次失败：${String(error.message).slice(0, 160)}`);
        current().error(error, bridge.lastText || '');
        (bridge.closeRound || closeRound)('error');
      });
    }

    const reason = await roundDone;
    adapter.end();
    return reason;
  }

  return { run, guidanceFor };
}

module.exports = { createBridgeTurn };
