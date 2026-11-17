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
    canCoalesceUserTurn, syncSessionUserTurn, hasCompactionChanged,
    getAllowedRoots, getPersistedTimeline, getPersistedDeliveries, rememberDeliveries, isFalsePositiveFilterError, rotatePoisonedSession, countTokens,
  } = deps;
  const BUILTIN = require('./config.js').BUILTIN_BRIDGE_GUIDANCE;
  const { now: diagnosticNow } = require('./diagnostics.js');
  const { summarizeToolSignatures, buildToolResultContent } = require('./bridge.js');
  const COALESCE_MS = 32;
  const TASK_COALESCE_MS = 65;
  const MAX_COALESCE_MS = 180;
  const DEFAULT_CONTINUE_TEXT = retryContinuePrompt || '请继续完成上一条请求（若此前已执行部分步骤，请直接基于已有上下文与结果继续，无需重复开头）。';


  function estimateTokens(text, round = true) {
    if (typeof countTokens === 'function') return countTokens(text, round);
    const str = String(text || '');
    if (!str) return 0;
    const cjk = (str.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const other = Math.max(0, (str.length - cjk) / 4);
    return cjk + (round ? Math.round(other) : other);
  }

  function syncPendingDelta(s) {
    if (!s || typeof s !== 'object') return 0;
    const total = Math.max(0, Math.round((s.pendingPreCallTokens || 0) + (s.pendingToolResultTokens || 0)));
    s.pendingDeltaTokens = total;
    return total;
  }

  function resetPendingDelta(s) {
    if (!s || typeof s !== 'object') return;
    s.pendingPreCallTokens = 0;
    s.pendingToolResultTokens = 0;
    s.pendingDeltaTokens = 0;
    s.initialPromptTokens = 0;
    s.currentStepHasOfficialUsage = false;
    s.awaitingPostToolModelCall = false;
  }
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
    if (bridge.running && typeof rememberDeliveries === 'function') rememberDeliveries(key, messages);
    bridge.adapter = adapter;
    bridge.latestMessages = messages;
    bridge.latestReq = req;
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
        if (Number.isFinite(bridge.activeStats.pendingPreCallTokens)) stats.pendingPreCallTokens = bridge.activeStats.pendingPreCallTokens;
        if (Number.isFinite(bridge.activeStats.pendingToolResultTokens)) stats.pendingToolResultTokens = bridge.activeStats.pendingToolResultTokens;
        if (Number.isFinite(bridge.activeStats.pendingDeltaTokens)) stats.pendingDeltaTokens = bridge.activeStats.pendingDeltaTokens;
        if (bridge.activeStats.turnUsage) stats.turnUsage = bridge.activeStats.turnUsage;
        stats.isBridgedTurn = bridge.activeStats.isBridgedTurn;
        for (const field of ['legOutputTokens', 'legThoughtTokens', 'reportedOutputTokens', 'reportedThoughtTokens']) stats[field] = bridge.activeStats[field] || 0;
      }
      return stats;
    };
    const addPreCallDelta = (tokens) => {
      const inc = Math.max(0, Number(tokens) || 0);
      if (inc <= 0) return;
      const target = bridge.activeStats || stats;
      target.pendingPreCallTokens = Math.max(0, target.pendingPreCallTokens || 0) + inc;
      const nextTotal = syncPendingDelta(target);
      if (target !== stats) {
        stats.pendingPreCallTokens = target.pendingPreCallTokens;
        stats.pendingDeltaTokens = nextTotal;
      }
    };
    const addToolResultDelta = (tokens, markBatchComplete = false) => {
      const inc = Math.max(0, Math.round(Number(tokens) || 0));
      const target = bridge.activeStats || stats;
      if (inc > 0) {
        target.pendingToolResultTokens = Math.max(0, Math.round(target.pendingToolResultTokens || 0)) + inc;
      }
      if (markBatchComplete) {
        target.awaitingPostToolModelCall = true;
        target.currentStepHasOfficialUsage = false;
      }
      const nextTotal = syncPendingDelta(target);
      if (target !== stats) {
        stats.pendingToolResultTokens = target.pendingToolResultTokens;
        stats.pendingDeltaTokens = nextTotal;
      }
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
      const compactionChanged = typeof hasCompactionChanged === 'function' && Boolean(hasCompactionChanged(key, messages));
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
          !compactionChanged &&
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
      const targetStats = bridge.activeStats || stats;
      if (targetStats.awaitingPostToolModelCall) {
        targetStats.pendingPreCallTokens = Math.max(0, Math.round((targetStats.pendingPreCallTokens || 0) + (targetStats.pendingToolResultTokens || 0)));
        targetStats.pendingToolResultTokens = 0;
        targetStats.awaitingPostToolModelCall = false;
        syncPendingDelta(targetStats);
      }
      targetStats.parkedBatches = (targetStats.parkedBatches || 0) + 1;
      targetStats.unreportedModelCalls = (targetStats.unreportedModelCalls || 0) + 1;
      if (!targetStats.currentStepHasOfficialUsage) {
        for (const p of bridge.parked) {
          if (p && !p._deltaCounted) {
            p._deltaCounted = true;
            const argStr = p.args !== undefined ? JSON.stringify(p.args) : '';
            addPreCallDelta(estimateTokens(p.rawName || p.name || '') + estimateTokens(argStr) + 6);
          }
        }
      } else {
        for (const p of bridge.parked) {
          if (p) p._deltaCounted = true;
        }
      }
      for (const p of bridge.parked) if (p && !p._outputCounted) {
        p._outputCounted = true;
        targetStats.legOutputTokens = (targetStats.legOutputTokens || 0) + estimateTokens(p.args === undefined ? '' : JSON.stringify(p.args));
      }
      targetStats.currentStepHasOfficialUsage = false;
      const parkedUsage = usageFor(bridge.lastPrompt || '', pendingText, '', currentStats());
      targetStats.diagnostics?.park(parkedUsage.context_used || 0, bridge.parked.length);
      current().park(bridge.parked, parkedUsage, pendingText);
      targetStats.reportedOutputTokens = (targetStats.reportedOutputTokens || 0) + parkedUsage.completion_tokens;
      targetStats.reportedThoughtTokens = (targetStats.reportedThoughtTokens || 0) + (parkedUsage.completion_tokens_details?.reasoning_tokens || 0);
      targetStats.legOutputTokens = 0;
      targetStats.legThoughtTokens = 0;
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
      if (!prepared.resume) {
        stats.contextUsed = 0;
        delete stats.contextSize;
        stats.turnUsage = null;
        resetPendingDelta(stats);
        if (bridge.activeStats && bridge.activeStats !== stats) {
          bridge.activeStats.contextUsed = 0;
          delete bridge.activeStats.contextSize;
          bridge.activeStats.turnUsage = null;
          resetPendingDelta(bridge.activeStats);
        }
      }
      if (bridges.get(key) !== bridge) bridges.set(key, bridge);
      bridge.sessionId = prepared.sessionId;
      bridge.running = true;
      bridge.activeStats = stats;
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
      // 新会话重放上下文与最近交付；续会话只发增量。
      const persistedTimeline = typeof getPersistedTimeline === 'function' ? getPersistedTimeline(key) : [];
      const persistedDeliveries = typeof getPersistedDeliveries === 'function' ? getPersistedDeliveries(key) : [];
      if (!prepared.resume && typeof flatten === 'function') promptText = flatten(messages, { persistedTimeline, persistedDeliveries });
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
      stats.isResumedPrompt = Boolean(prepared.resume);
      stats.isBridgedTurn = true;
      stats.legOutputTokens = 0;
      stats.legThoughtTokens = 0;
      stats.reportedOutputTokens = 0;
      stats.reportedThoughtTokens = 0;
      resetPendingDelta(stats);
      bridge.activeStats = stats;
      const handleStreamUpdate = (u) => {
        if (!u || !isCurrent()) return;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
          if (!stats.currentStepHasOfficialUsage) {
            addPreCallDelta(estimateTokens(u.content.text, false));
          }
          stats.legOutputTokens += estimateTokens(u.content.text, false);
          bridge.lastText = (bridge.lastText || '') + u.content.text;
          current().text(u.content.text, usageFor(bridge.lastPrompt || '', bridge.lastText, '', currentStats()));
          return;
        }
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
          if (!stats.currentStepHasOfficialUsage) {
            addPreCallDelta(estimateTokens(u.content.text, false));
          }
          stats.legThoughtTokens += estimateTokens(u.content.text, false);
          current().thought(u.content.text);
          return;
        }
        if (u.sessionUpdate === 'gateway_keepalive') {
          if (typeof current().keepalive === 'function') current().keepalive(u.text || '');
          else if (u.text) current().thought(u.text);
        }
      };
      try {
        try {
          // 前缀缓存对齐：首轮注入规范化工具引导词作为固定锚点；续会话（resume）时直接复用已有会话上下文，避免重复注入破坏前缀缓存
          const prefix = !prepared.resume ? guidanceFor(tools) : '';
          const fullPrompt = prefix ? (prefix + promptText) : promptText;
          const promptMediaTokens = Array.isArray(images) ? images.length * 258 : 0;
          const initPromptTokens = estimateTokens(fullPrompt) + promptMediaTokens;
          if (!prepared.resume && !(stats.contextUsed > 0)) {
            stats.initialPromptTokens = initPromptTokens;
          }
          addPreCallDelta(initPromptTokens);
          await prompt(prepared.sessionId, fullPrompt, handleStreamUpdate, images, docs, stats, policy, concreteModel);
        } catch (firstErr) {
          const activeCfgNow = (typeof getConfig === 'function' ? getConfig() : cfg) || {};
          const maxFilterRetries = Math.max(0, Number(activeCfgNow.contentFilterMaxRetries ?? 2));
          const canSalvageSession =
            maxFilterRetries >= 2 &&
            isCurrent() &&
            !stats.task?.cancelled &&
            !(bridge.lastText || '').trim() &&
            !(Array.isArray(bridge.parked) && bridge.parked.length > 0) &&
            typeof isFalsePositiveFilterError === 'function' &&
            isFalsePositiveFilterError(firstErr) &&
            typeof rotatePoisonedSession === 'function' &&
            typeof flatten === 'function';
          if (!canSalvageSession) throw firstErr;
          log(`桥接：当前会话历史轨迹持续触发上游安全过滤器误判，自动轮换纯净会话并脱敏挽救任务结果（对话 ${String(key).slice(0, 12)}）`);
          if (typeof current().keepalive === 'function') {
            current().keepalive('🛡️ 历史轨迹触发上游安全过滤器误判，正在自动轮换纯净会话并脱敏续接结果…\n');
          }
          clearParked(bridge, '安全过滤误判轮换纯净会话');
          await rotatePoisonedSession(key, prepared.sessionId);
          if (!isCurrent()) {
            throw Object.assign(new Error('Prompt superseded during filter salvage'), { code: 'PROMPT_CANCELLED' });
          }
          const latestMessages = Array.isArray(bridge.latestMessages) && bridge.latestMessages.length > 0 ? bridge.latestMessages : messages;
          const latestReq = bridge.latestReq || req;
          const latestTools = Array.isArray(bridge.tools) && bridge.tools.length > 0 ? bridge.tools : tools;
          const salvaged = await sessionFor(concreteModel, latestMessages, latestReq, [{ type: 'http', name: 'pi-bridge', url: bridgeUrl, headers: [] }]);
          bridge.sessionId = salvaged.sessionId;
          bridge.running = true;
          if (stats.task) {
            stats.task.sessionId = salvaged.sessionId;
            stats.task.active = true;
          }
          if (salvaged.turnSig) stats.turnSig = salvaged.turnSig;
          if (Array.isArray(salvaged.nextUserHistory)) stats.nextUserHistory = salvaged.nextUserHistory;
          stats.contextUsed = 0;
          delete stats.contextSize;
          stats.turnUsage = null;
          resetPendingDelta(stats);
          stats.skipInSessionFilterRetry = true;
          stats.isResumedPrompt = false;
          const salvageTimeline = typeof getPersistedTimeline === 'function' ? getPersistedTimeline(key) : persistedTimeline;
          const salvageDeliveries = typeof getPersistedDeliveries === 'function' ? getPersistedDeliveries(key) : persistedDeliveries;
          const sanitizedFlat = flatten(latestMessages, { persistedTimeline: salvageTimeline, persistedDeliveries: salvageDeliveries, filterSafe: true });
          const salvagePrefix = guidanceFor(latestTools);
          const salvagePrompt = salvagePrefix ? (salvagePrefix + sanitizedFlat) : sanitizedFlat;
          const salvageImages = typeof promptImagesFor === 'function' ? promptImagesFor(salvaged, latestMessages) : images;
          const salvageDocs = typeof promptDocsFor === 'function' ? promptDocsFor(salvaged, latestMessages) : docs;
          const salvageMediaTokens = Array.isArray(salvageImages) ? salvageImages.length * 258 : 0;
          const salvageInitTokens = estimateTokens(salvagePrompt) + salvageMediaTokens;
          stats.initialPromptTokens = salvageInitTokens;
          addPreCallDelta(salvageInitTokens);
          bridge.waiting = true;
          await prompt(salvaged.sessionId, salvagePrompt, handleStreamUpdate, salvageImages, salvageDocs, stats, policy, concreteModel);
        }
        if (!isCurrent()) return;
        clearParked(bridge, '本轮已结束');
        current().finish(usageFor(bridge.lastPrompt || '', bridge.lastText || '', '', currentStats()), bridge.lastText || '');
        (bridge.closeRound || closeRound)('done');
      } finally {
        if (stats.task) stats.task.active = false;
        if (isCurrent()) {
          bridge.running = false;
          resetPendingDelta(stats);
          if (bridge.activeStats) {
            bridge.activeStats.turnUsage = null;
            resetPendingDelta(bridge.activeStats);
          }
        }
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
      } else if (remaining.length === 0 && typeof hasCompactionChanged === 'function' && hasCompactionChanged(key, messages)) {
        // 当前通道挂起期间（例如挂起 Task 保护未抢占，或宿主通过外部模型完成摘要）发生了真实阶段压缩：
        // 绝不能再把结果塞回已膨胀的旧会话，必须立即释放旧挂起轮次并走 sessionFor 压缩重建流。
        log(`桥接：检测到当前会话已完成阶段压缩（含挂起 Task 或跨端摘要），释放旧挂起轮次并切换至压缩重建流（对话 ${String(key).slice(0, 12)}）`);
        bridge.gen = (bridge.gen || 0) + 1;
        notifyBridgeAbort();
        clearParked(bridge, '当前会话已完成阶段压缩，重置底层会话');
        supersedeOlderRounds('steered');
        bridge.running = false;
        if (bridge.activeStats) {
          bridge.activeStats.turnUsage = null;
          resetPendingDelta(bridge.activeStats);
        }
        if (bridge.sessionId) {
          const targetSid = bridge.sessionId;
          try { acp.notify('session/cancel', { sessionId: targetSid }); } catch { /* ignore */ }
          if (typeof waitPromptIdle === 'function') {
            await waitPromptIdle(targetSid, '释放挂起轮次（当前会话已完成阶段压缩）');
          } else {
            try { if (typeof acp.abandon === 'function') acp.abandon('session/prompt', '释放挂起轮次（当前会话已完成阶段压缩）', targetSid); } catch { /* ignore */ }
          }
          bridge.sessionId = null;
        }
      } else {
        if (coalescedUserNote && typeof syncSessionUserTurn === 'function') {
          try { syncSessionUserTurn(key, messages, req); } catch { /* ignore */ }
        }
        bridge.parked = remaining;
        if (bridge.activeStats) bridge.activeStats.legText = 0;
        const resumeGen = bridge.gen || 0;
        const activeCfg = (typeof getConfig === 'function' ? getConfig() : cfg) || {};
        const resumeDiagnostics = (bridge.activeStats || stats).diagnostics;
        const resumeStarted = remaining.length === 0 ? resumeDiagnostics?.startResume() : null;
        let throttleMs = 0;
        const isResumeAborted = () => Boolean(stats.task?.cancelled) || (bridge.gen || 0) !== resumeGen || !isLatestReq();
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
          const csNow = currentStats();
          const curUsed = Number(csNow.contextUsed || 0) + Number(csNow.pendingDeltaTokens || 0);
          if (throttleThreshold > 0 && throttleMinMs > 0 && curUsed >= throttleThreshold && bridge.toolBurstCount >= 4) {
            const delayMs = throttleMinMs;
            if (delayMs >= 150) {
              log(`桥接微节流：高上下文（${curUsed} tokens，连续第 ${bridge.toolBurstCount} 轮工具回填）平滑缓冲 ${delayMs}ms 以防瞬时 TPM 429`);
              const throttleStarted = diagnosticNow();
              await sleepAbortableLocal(delayMs, isResumeAborted, registerResumeAbort);
              throttleMs += diagnosticNow() - throttleStarted;
            }
          }
        }
        const resolveAbortedMatched = () => {
          const isOwnCancel = Boolean(stats.task?.cancelled) && (bridge.gen || 0) === resumeGen && isLatestReq();
          const abortReasonText = isOwnCancel ? '客户端断开连接（停止）' : '当前轮次已被新请求接管';
          for (const { item } of matched) {
            if (!item || item._abortResolved) continue;
            item._abortResolved = true;
            try { item.resolve({ content: [{ type: 'text', text: abortReasonText }], isError: true }); } catch { /* ignore */ }
          }
          return isOwnCancel;
        };
        const unregisterRootAbort = registerResumeAbort(() => {
          if (isResumeAborted()) resolveAbortedMatched();
        });
        let rootSpec = null;
        try {
          rootSpec = (!isResumeAborted() && typeof getAllowedRoots === 'function')
            ? await getAllowedRoots(messages)
            : null;
        } finally {
          unregisterRootAbort();
        }
        const allowedRoots = Array.isArray(rootSpec)
          ? rootSpec
          : (rootSpec && Array.isArray(rootSpec.roots) ? rootSpec.roots : []);
        const allowedCwd = (rootSpec && typeof rootSpec === 'object' && !Array.isArray(rootSpec) && typeof rootSpec.cwd === 'string')
          ? rootSpec.cwd
          : '';
        if (isResumeAborted()) {
          const isOwnCancel = resolveAbortedMatched();
          if (stats.task) stats.task.active = false;
          if (isOwnCancel) {
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
          try { adapter.finish(usageFor('', '', '', stats), ''); } catch { /* ignore */ }
          adapter.end();
          closeRound('steered');
          return 'steered';
        }
        for (let idx = 0; idx < matched.length; idx += 1) {
          const { item, msg } = matched[idx];
          let resultText = toolResultText(msg);
          if (coalescedUserNote && idx === matched.length - 1) {
            resultText = `${resultText}\n\n[宿主本轮因工具连续报错已暂停自动重试，用户补充最新指示继续执行]\n${coalescedUserNote}`;
          }
          let fallbackInfo = null;
          const contentBlocks = buildToolResultContent(msg, {
            resultText,
            allowedRoots,
            toolCall: item,
            cwd: allowedCwd,
            onLocalImageFallback: (info) => { fallbackInfo = info; },
          });
          const imageCount = contentBlocks.filter((b) => b && b.type === 'image').length;
          const isLastMatched = idx === matched.length - 1;
          if (item && !item._resultDeltaCounted) {
            item._resultDeltaCounted = true;
            addToolResultDelta(estimateTokens(resultText) + (imageCount * 258), isLastMatched && remaining.length === 0);
          } else if (isLastMatched && remaining.length === 0) {
            addToolResultDelta(0, true);
          }
          if (isLastMatched && remaining.length === 0 && resumeDiagnostics) {
            const cs = currentStats();
            resumeDiagnostics.resume(resumeStarted, throttleMs, matched.length, (cs.contextUsed || 0) + (cs.pendingDeltaTokens || 0));
          }
          item.resolve({ content: contentBlocks });
          log(`桥接：已回填工具结果（${item.name}，${resultText.length} 字${imageCount > 0 ? `，含图片 ${imageCount} 张${fallbackInfo ? ' [本地白名单补齐]' : ''}` : ''}${coalescedUserNote && idx === matched.length - 1 ? '，已合并用户续推指令' : ''}）`);
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
        stats.turnUsage = null;
        bridge.activeStats = stats;
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
