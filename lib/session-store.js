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
// 一天没动过的足迹没意义：运行时那边的 worker 早回收了，留着只会白试一次 session/load。
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_MS = 800;

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
      entries.set(item.key, {
        sessionId: item.sessionId,
        model: String(item.model || ''),
        bridgeUrl: String(item.bridgeUrl || ''),
        touched,
      });
    }
    if (entries.size > 0) log(`已载入 ${entries.size} 条会话足迹（重启后优先 session/load 还原）`);
    return entries.size;
  }

  function flush() {
    if (!dirty || !file) return;
    dirty = false;
    const now = Date.now();
    const list = [];
    for (const [key, value] of [...entries.entries()]) {
      if (now - value.touched > MAX_AGE_MS) {
        entries.delete(key);
        continue;
      }
      list.push({ key, sessionId: value.sessionId, model: value.model, bridgeUrl: value.bridgeUrl, touched: value.touched });
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: VERSION, sessions: list }, null, 1), 'utf8');
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
      entries.set(key, {
        sessionId: String(value.sessionId),
        model: String(value.model || ''),
        bridgeUrl: String(value.bridgeUrl || ''),
        touched: Number(value.touched) || Date.now(),
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

module.exports = { createSessionStore, MAX_AGE_MS, VERSION };
