'use strict';

/**
 * 会话足迹。
 *
 * ACP 的 `sessionId` 只活在内存里，网关一重启就丢，于是下一轮只能 `session/new` +
 * 把整段历史重放一遍。运行时的 `initialize` 明确回了：
 *   agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }
 * 也就是说会话本体落在运行时的 brain 目录里，重启后可以用 `session/load` 拿回来。
 *
 * 这里只存「对话键 → sessionId」这层映射，不存任何对话内容：
 *   键 = lib/server.js 的 keyFor()（宿主会话标识，或「系统提示 + 首条 user 消息」的哈希），
 *   跨重启稳定，所以能对上同一轮对话。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
// 足迹只是一行 JSON，留着几乎不要钱；丢了却要重放整段历史（服务端前缀缓存全灭）。
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
      entries.set(item.key, {
        sessionId: item.sessionId,
        model: String(item.model || ''),
        bridgeUrl: String(item.bridgeUrl || ''),
        touched,
        ...(contextUsed ? { contextUsed } : {}),
        ...(contextSize ? { contextSize } : {}),
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
        ...(value.contextUsed > 0 ? { contextUsed: value.contextUsed } : {}),
        ...(value.contextSize > 0 ? { contextSize: value.contextSize } : {}),
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
      const contextUsed = Number(value.contextUsed) > 0 ? Number(value.contextUsed) : (sameSid && prev.contextUsed > 0 ? prev.contextUsed : 0);
      const contextSize = Number(value.contextSize) > 0 ? Number(value.contextSize) : (sameSid && prev.contextSize > 0 ? prev.contextSize : 0);
      entries.set(key, {
        sessionId: nextSid,
        model: String(value.model || ''),
        bridgeUrl: String(value.bridgeUrl || ''),
        touched: Number(value.touched) || Date.now(),
        ...(contextUsed ? { contextUsed } : {}),
        ...(contextSize ? { contextSize } : {}),
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
