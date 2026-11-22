'use strict';

/**
 * 会话足迹。
 *
 * ACP 的 `sessionId` 只活在内存里，网关一重启就丢，于是下一轮只能 `session/new` +
 * 把整段历史重放一遍。运行时的 `initialize` 明确回了：
 *   agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }
 * 也就是说会话本体落在运行时的 brain 目录里，重启后可以用 `session/load` 拿回来。
 *
 * 保存会话映射、有界用户意图与最近子代理交付；不保存全量对话或凭据：
 *   键 = lib/server.js 的 keyFor()（宿主会话标识，或「系统提示 + 首条 user 消息」的哈希），
 *   跨重启稳定，所以能对上同一轮对话。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  boundUserTimeline, dedupChronological, fits,
  DELIVERY_MAX_ITEMS, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES, DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES,
} = require('./context.js');

function sanitizePersistedDeliveries(items = []) {
  const valid = dedupChronological(items).filter((s) => fits(s, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES));
  const sliced = valid.slice(-DELIVERY_MAX_ITEMS);
  while (sliced.length > 1 && !fits(sliced.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) {
    sliced.shift();
  }
  return sliced.length === 1 && !fits(sliced[0], DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES) ? [] : sliced;
}

function sanitizeResponseCheckpoints(items = []) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items.slice(-8)) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    const userDepth = Number.isFinite(Number(raw.userDepth)) && Number(raw.userDepth) >= 0 ? Math.floor(Number(raw.userDepth)) : 0;
    const userTimeline = boundUserTimeline(raw.userTimeline);
    out.push({
      id: raw.id.trim(),
      userDepth,
      ...(userTimeline.length > 0 ? { userTimeline } : {}),
    });
  }
  return out;
}

const VERSION = 1;
// 足迹包含有界意图与近期交付；避免无谓重放，同时按时间与条数淘汰。
// 实测 session/close 之后再 session/load/resume，历史仍在——所以「运行时早回收了」不是丢弃的理由。
// 留 7 天；真接不回来时 load 会失败，代价只是一次 RPC，然后才退化成新建。
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// 兜底上限：足迹再小也不无限堆，超了按最久未用淘汰。
const MAX_ENTRIES = 500;
const FLUSH_MS = 800;

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}
function createSessionStore({ file = '', log = () => {} } = {}) {
  const entries = new Map();
  let timer = null;
  let dirty = false;

  function load() {
    if (!file) return 0;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') log(`会话足迹读取失败：${String(error.message).slice(0, 120)}`);
      return 0;
    }
    const list = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
    const now = Date.now();
    for (const item of list) {
      if (!item || typeof item.key !== 'string' || typeof item.sessionId !== 'string') continue;
      const touched = Number(item.touched) || 0;
      if (!touched || now - touched > MAX_AGE_MS) continue;
      const contextUsed = Number(item.contextUsed) > 0 ? Number(item.contextUsed) : 0;
      const contextSize = Number(item.contextSize) > 0 ? Number(item.contextSize) : 0;
      const userHistory = Array.isArray(item.userHistory)
        ? item.userHistory.filter((x) => typeof x === 'string' && x).slice(-200)
        : [];
      const userTimeline = boundUserTimeline(item.userTimeline);
      const recentDeliveries = sanitizePersistedDeliveries(item.recentDeliveries);
      const invalidated = item.invalidated === true;
      const explicitHostKey = typeof item.explicitHostKey === 'string' ? item.explicitHostKey : '';
      const lastResponseId = typeof item.lastResponseId === 'string' ? item.lastResponseId.trim() : '';
      const responseCheckpoints = sanitizeResponseCheckpoints(item.responseCheckpoints);
      const hasDispatchedPrompt = invalidated ? false : item.hasDispatchedPrompt !== false;
      const dispatchedTurnSig = invalidated ? '' : (typeof item.dispatchedTurnSig === 'string' ? item.dispatchedTurnSig : '');
      const compactionSig = invalidated ? '' : (typeof item.compactionSig === 'string' ? item.compactionSig : '');
      const systemSig = typeof item.systemSig === 'string' ? item.systemSig : '';
      const turnCompactionCount = Number.isFinite(Number(item.turnCompactionCount)) && Number(item.turnCompactionCount) > 0
        ? Math.floor(Number(item.turnCompactionCount))
        : 0;
      const turnCompactionSig = typeof item.turnCompactionSig === 'string' ? item.turnCompactionSig : '';
      const turnOpen = item.turnOpen === true;
      const turnLastHumanFp = typeof item.turnLastHumanFp === 'string' ? item.turnLastHumanFp : '';
      const turnHumanCount = Number.isFinite(Number(item.turnHumanCount)) && Number(item.turnHumanCount) > 0
        ? Math.floor(Number(item.turnHumanCount))
        : 0;
      entries.set(item.key, {
        sessionId: item.sessionId,
        model: String(item.model || ''),
        bridgeUrl: String(item.bridgeUrl || ''),
        touched,
        hasDispatchedPrompt,
        ...(invalidated ? { invalidated: true } : {}),
        ...(explicitHostKey ? { explicitHostKey } : {}),
        ...(lastResponseId ? { lastResponseId } : {}),
        ...(responseCheckpoints.length > 0 ? { responseCheckpoints } : {}),
        ...(dispatchedTurnSig ? { dispatchedTurnSig } : {}),
        ...(compactionSig ? { compactionSig } : {}),
        ...(systemSig ? { systemSig } : {}),
        ...(turnCompactionCount > 0 ? { turnCompactionCount } : {}),
        ...(turnCompactionSig ? { turnCompactionSig } : {}),
        ...(turnOpen ? { turnOpen: true } : {}),
        ...(turnLastHumanFp ? { turnLastHumanFp } : {}),
        ...(turnHumanCount > 0 ? { turnHumanCount } : {}),
        ...(contextUsed ? { contextUsed } : {}),
        ...(contextSize ? { contextSize } : {}),
        ...(userHistory.length > 0 ? { userHistory } : {}),
        ...(userTimeline.length > 0 ? { userTimeline } : {}),
        ...(recentDeliveries.length > 0 ? { recentDeliveries } : {}),
      });
    }
    if (entries.size > 0) log(`已载入 ${entries.size} 条会话足迹（重启后优先 session/load 还原）`);
    return entries.size;
  }

  function flush() {
    if (!dirty || !file) return;
    dirty = false;
    const now = Date.now();
    let list = [];
    for (const [key, value] of [...entries.entries()]) {
      if (now - value.touched > MAX_AGE_MS) {
        entries.delete(key);
        continue;
      }
      list.push({
        key,
        sessionId: value.sessionId,
        model: value.model,
        bridgeUrl: value.bridgeUrl,
        touched: value.touched,
        ...(value.invalidated ? { invalidated: true } : {}),
        ...(value.explicitHostKey ? { explicitHostKey: value.explicitHostKey } : {}),
        ...(value.lastResponseId ? { lastResponseId: value.lastResponseId } : {}),
        ...(Array.isArray(value.responseCheckpoints) && value.responseCheckpoints.length > 0 ? { responseCheckpoints: sanitizeResponseCheckpoints(value.responseCheckpoints) } : {}),
        ...(value.hasDispatchedPrompt === false ? { hasDispatchedPrompt: false } : {}),
        ...(value.dispatchedTurnSig ? { dispatchedTurnSig: value.dispatchedTurnSig } : {}),
        ...(value.compactionSig ? { compactionSig: value.compactionSig } : {}),
        ...(value.systemSig ? { systemSig: value.systemSig } : {}),
        ...(value.turnCompactionCount > 0 ? { turnCompactionCount: Math.floor(Number(value.turnCompactionCount)) } : {}),
        ...(value.turnCompactionSig ? { turnCompactionSig: value.turnCompactionSig } : {}),
        ...(value.turnOpen ? { turnOpen: true } : {}),
        ...(value.turnLastHumanFp ? { turnLastHumanFp: value.turnLastHumanFp } : {}),
        ...(value.turnHumanCount > 0 ? { turnHumanCount: Math.floor(Number(value.turnHumanCount)) } : {}),
        ...(value.contextUsed > 0 ? { contextUsed: value.contextUsed } : {}),
        ...(value.contextSize > 0 ? { contextSize: value.contextSize } : {}),
        ...(Array.isArray(value.userHistory) && value.userHistory.length > 0 ? { userHistory: value.userHistory.slice(-200) } : {}),
        ...(Array.isArray(value.userTimeline) && value.userTimeline.length > 0 ? { userTimeline: boundUserTimeline(value.userTimeline) } : {}),
        ...(value.recentDeliveries?.length ? { recentDeliveries: sanitizePersistedDeliveries(value.recentDeliveries) } : {}),
      });
    }
    if (list.length > MAX_ENTRIES) {
      list.sort((a, b) => b.touched - a.touched);
      for (const item of list.slice(MAX_ENTRIES)) entries.delete(item.key);
      list = list.slice(0, MAX_ENTRIES);
    }
    try {
      writeAtomic(file, { version: VERSION, sessions: list });
    } catch (error) {
      log(`会话足迹写入失败：${String(error.message).slice(0, 120)}`);
    }
  }

  function schedule() {
    dirty = true;
    if (timer || !file) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    file,
    load,
    list: () => [...entries.entries()].map(([key, value]) => ({ key, ...value })),
    get: (key) => entries.get(key) || null,
    set(key, value) {
      if (!key || !value || !value.sessionId) return;
      const nextSid = String(value.sessionId);
      const prev = entries.get(key);
      const sameSid = prev && prev.sessionId === nextSid;
      const carryRecoverable = sameSid || Boolean(prev && prev.invalidated);
      const invalidated = value.invalidated !== undefined
        ? Boolean(value.invalidated)
        : (sameSid ? Boolean(prev.invalidated) : false);
      const explicitHostKey = value.explicitHostKey === null
        ? ''
        : ((typeof value.explicitHostKey === 'string' && value.explicitHostKey)
          ? value.explicitHostKey
          : ((carryRecoverable && prev?.explicitHostKey) ? String(prev.explicitHostKey) : ''));
      const lastResponseId = value.lastResponseId === null
        ? ''
        : ((typeof value.lastResponseId === 'string' && value.lastResponseId.trim())
          ? value.lastResponseId.trim()
          : ((carryRecoverable && prev?.lastResponseId) ? String(prev.lastResponseId) : ''));
      const responseCheckpoints = value.responseCheckpoints === null
        ? []
        : sanitizeResponseCheckpoints(value.responseCheckpoints !== undefined ? value.responseCheckpoints : (carryRecoverable ? prev?.responseCheckpoints : []));
      const contextUsed = invalidated ? 0 : (Number(value.contextUsed) > 0 ? Number(value.contextUsed) : (sameSid && prev.contextUsed > 0 ? prev.contextUsed : 0));
      const contextSize = invalidated ? 0 : (Number(value.contextSize) > 0 ? Number(value.contextSize) : (sameSid && prev.contextSize > 0 ? prev.contextSize : 0));
      const userHistory = invalidated
        ? []
        : (Array.isArray(value.userHistory)
          ? value.userHistory.filter((x) => typeof x === 'string' && x).slice(-200)
          : (sameSid && Array.isArray(prev.userHistory) ? prev.userHistory : []));
      const userTimeline = value.userTimeline === null
        ? []
        : boundUserTimeline((Array.isArray(value.userTimeline) && value.userTimeline.length > 0) ? value.userTimeline : (carryRecoverable ? prev?.userTimeline : []));
      const recentDeliveries = sanitizePersistedDeliveries(value.recentDeliveries ?? (carryRecoverable ? prev?.recentDeliveries : []));
      const hasDispatchedPrompt = invalidated
        ? false
        : (value.hasDispatchedPrompt !== undefined
          ? Boolean(value.hasDispatchedPrompt)
          : (sameSid && prev.hasDispatchedPrompt !== undefined ? Boolean(prev.hasDispatchedPrompt) : true));
      const dispatchedTurnSig = invalidated
        ? ''
        : (value.dispatchedTurnSig !== undefined
          ? String(value.dispatchedTurnSig || '')
          : (sameSid && prev.dispatchedTurnSig ? String(prev.dispatchedTurnSig) : ''));
      const compactionSig = invalidated || value.compactionSig === null
        ? ''
        : ((typeof value.compactionSig === 'string' && value.compactionSig)
          ? value.compactionSig
          : (sameSid && prev.compactionSig ? String(prev.compactionSig) : ''));
      const systemSig = value.systemSig === null
        ? ''
        : ((typeof value.systemSig === 'string' && value.systemSig)
          ? value.systemSig
          : (sameSid && prev.systemSig ? String(prev.systemSig) : ''));
      const turnCompactionCount = value.turnCompactionCount === null
        ? 0
        : (value.turnCompactionCount !== undefined
          ? (Number.isFinite(Number(value.turnCompactionCount)) && Number(value.turnCompactionCount) > 0 ? Math.floor(Number(value.turnCompactionCount)) : 0)
          : (carryRecoverable && prev?.turnCompactionCount > 0 ? Math.floor(Number(prev.turnCompactionCount)) : 0));
      const turnCompactionSig = value.turnCompactionSig === null
        ? ''
        : ((typeof value.turnCompactionSig === 'string' && value.turnCompactionSig)
          ? value.turnCompactionSig
          : ((carryRecoverable && prev?.turnCompactionSig) ? String(prev.turnCompactionSig) : ''));
      const turnOpen = value.turnOpen === null
        ? false
        : (value.turnOpen !== undefined
          ? Boolean(value.turnOpen)
          : (carryRecoverable ? Boolean(prev?.turnOpen) : false));
      const turnLastHumanFp = value.turnLastHumanFp === null
        ? ''
        : ((typeof value.turnLastHumanFp === 'string' && value.turnLastHumanFp)
          ? value.turnLastHumanFp
          : ((carryRecoverable && prev?.turnLastHumanFp) ? String(prev.turnLastHumanFp) : ''));
      const turnHumanCount = value.turnHumanCount === null
        ? 0
        : (value.turnHumanCount !== undefined
          ? (Number.isFinite(Number(value.turnHumanCount)) && Number(value.turnHumanCount) > 0 ? Math.floor(Number(value.turnHumanCount)) : 0)
          : (carryRecoverable && prev?.turnHumanCount > 0 ? Math.floor(Number(prev.turnHumanCount)) : 0));
      entries.set(key, {
        sessionId: nextSid,
        model: String(value.model || ''),
        bridgeUrl: String(value.bridgeUrl || ''),
        touched: Number(value.touched) || Date.now(),
        hasDispatchedPrompt,
        ...(invalidated ? { invalidated: true } : {}),
        ...(explicitHostKey ? { explicitHostKey } : {}),
        ...(lastResponseId ? { lastResponseId } : {}),
        ...(responseCheckpoints.length > 0 ? { responseCheckpoints } : {}),
        ...(dispatchedTurnSig ? { dispatchedTurnSig } : {}),
        ...(compactionSig ? { compactionSig } : {}),
        ...(systemSig ? { systemSig } : {}),
        ...(turnCompactionCount > 0 ? { turnCompactionCount } : {}),
        ...(turnCompactionSig ? { turnCompactionSig } : {}),
        ...(turnOpen ? { turnOpen: true } : {}),
        ...(turnLastHumanFp ? { turnLastHumanFp } : {}),
        ...(turnHumanCount > 0 ? { turnHumanCount } : {}),
        ...(contextUsed ? { contextUsed } : {}),
        ...(contextSize ? { contextSize } : {}),
        ...(userHistory.length > 0 ? { userHistory } : {}),
        ...(userTimeline.length > 0 ? { userTimeline } : {}),
        ...(recentDeliveries.length > 0 ? { recentDeliveries } : {}),
      });
      schedule();
    },
    invalidate(key, meta = {}) {
      if (!key) return;
      const prev = entries.get(key);
      const timeline = boundUserTimeline(meta.userTimeline !== undefined ? meta.userTimeline : (prev?.userTimeline || []));
      const deliveries = sanitizePersistedDeliveries(meta.recentDeliveries !== undefined ? meta.recentDeliveries : (prev?.recentDeliveries || []));
      const explicitHostKey = String(meta.explicitHostKey || prev?.explicitHostKey || '');
      const lastResponseId = String(meta.lastResponseId !== undefined ? (meta.lastResponseId || '') : (prev?.lastResponseId || '')).trim();
      const responseCheckpoints = sanitizeResponseCheckpoints(meta.responseCheckpoints !== undefined ? meta.responseCheckpoints : (prev?.responseCheckpoints || []));
      const turnCompactionCount = meta.turnCompactionCount !== undefined
        ? (Number.isFinite(Number(meta.turnCompactionCount)) && Number(meta.turnCompactionCount) > 0 ? Math.floor(Number(meta.turnCompactionCount)) : 0)
        : (prev?.turnCompactionCount > 0 ? Math.floor(Number(prev.turnCompactionCount)) : 0);
      const turnCompactionSig = String(meta.turnCompactionSig !== undefined ? (meta.turnCompactionSig || '') : (prev?.turnCompactionSig || ''));
      const turnOpen = meta.turnOpen !== undefined ? Boolean(meta.turnOpen) : Boolean(prev?.turnOpen);
      const turnLastHumanFp = String(meta.turnLastHumanFp !== undefined ? (meta.turnLastHumanFp || '') : (prev?.turnLastHumanFp || ''));
      const turnHumanCount = meta.turnHumanCount !== undefined
        ? (Number.isFinite(Number(meta.turnHumanCount)) && Number(meta.turnHumanCount) > 0 ? Math.floor(Number(meta.turnHumanCount)) : 0)
        : (prev?.turnHumanCount > 0 ? Math.floor(Number(prev.turnHumanCount)) : 0);
      if (
        timeline.length === 0 &&
        deliveries.length === 0 &&
        !explicitHostKey &&
        !lastResponseId &&
        responseCheckpoints.length === 0 &&
        turnCompactionCount === 0 &&
        !turnCompactionSig &&
        !turnOpen &&
        !turnLastHumanFp &&
        turnHumanCount === 0
      ) {
        if (entries.delete(key)) schedule();
        return;
      }
      entries.set(key, {
        sessionId: String(meta.sessionId || prev?.sessionId || '__invalidated__'),
        model: String(meta.model || prev?.model || ''),
        bridgeUrl: String(meta.bridgeUrl !== undefined ? meta.bridgeUrl : (prev?.bridgeUrl || '')),
        touched: Number(meta.touched) || Date.now(),
        invalidated: true,
        hasDispatchedPrompt: false,
        ...(explicitHostKey ? { explicitHostKey } : {}),
        ...(lastResponseId ? { lastResponseId } : {}),
        ...(responseCheckpoints.length > 0 ? { responseCheckpoints } : {}),
        ...(turnCompactionCount > 0 ? { turnCompactionCount } : {}),
        ...(turnCompactionSig ? { turnCompactionSig } : {}),
        ...(turnOpen ? { turnOpen: true } : {}),
        ...(turnLastHumanFp ? { turnLastHumanFp } : {}),
        ...(turnHumanCount > 0 ? { turnHumanCount } : {}),
        ...(timeline.length > 0 ? { userTimeline: timeline } : {}),
        ...(deliveries.length > 0 ? { recentDeliveries: deliveries } : {}),
      });
      schedule();
    },
    touch(key) {
      const hit = entries.get(key);
      if (!hit) return;
      hit.touched = Date.now();
      schedule();
    },
    remove(key) {
      if (entries.delete(key)) schedule();
    },
    clear() {
      if (entries.size === 0) return;
      entries.clear();
      schedule();
    },
    flush,
    size: () => entries.size,
  };
}

module.exports = { createSessionStore, MAX_AGE_MS, VERSION, writeAtomic };
