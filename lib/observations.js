'use strict';

/**
 * 每次 HTTP 模型请求的 ACP 水位凭据（receipt）与只读观测表。
 *
 * 合同：
 *   - 一个 HTTP 模型请求 = 一个 128 位随机凭据（32 位小写 hex），放在响应头
 *     `x-antigravity-acp-context-id`；
 *   - 只读 GET /v1/antigravity/context/<receipt> 返回
 *     `{version:1, state:'pending'|'observed'|'unavailable', observation?:{used,size?}}`；
 *   - `used` 只来自**本 HTTP 步已派发或已向 ACP 回填**的可归属原始
 *     `usage_update.used`：`Number.isSafeInteger` 且非负，不做四舍五入，0 合法，
 *     允许真实回落；不从 contextUsed / pendingDelta / 计费 / 累计值倒推；
 *   - `size` 只取自**同一条 update** 的合法正安全整数；该 update 没有合法 size 就
 *     不报 size，绝不借用上一条样本的旧 size；
 *   - 新派发或尝试失败时清除暂存样本，不能把前一次尝试的水位借给重试；网关另行
 *     排除同 SID 无法区分新旧通知的重试，不靠清空样本推断通知归属；
 *   - 只存数值与状态，绝不存 prompt、session、模型或鉴权信息；
 *   - 仅内存、TTL + 条数上限；过期/未知凭据一律当作不存在。
 *
 * 观测对象由单条 HTTP 腿与表共用，HTTP 结束时调用 finish() 冻结。
 * 活跃派发、工具回填边界和同 SID 的歧义由网关管理，不写入凭据表。
 */

const crypto = require('node:crypto');
const net = require('node:net');

const VERSION = 1;
const RECEIPT_PATTERN = /^[0-9a-f]{32}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 512;

/** loopback 对端：127.0.0.0/8、::1、IPv4-mapped ::ffff:127.x。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  let addr = address;
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  if (addr === '::1') return true;
  if (!net.isIPv4(addr)) return false;
  const octets = addr.split('.');
  if (octets.length !== 4) return false;
  for (const part of octets) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return false;
  }
  return Number(octets[0]) === 127;
}

/**
 * 非负安全整数：严格 `Number.isSafeInteger`，不做任何四舍五入。
 * 0（含 -0）合法；负数、小数、NaN、Infinity、超安全范围、字符串一律拒绝。
 */
function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value === 0 ? 0 : value;
}

/** 正安全整数：窗口大小只接受严格 `Number.isSafeInteger` 且 > 0。 */
function positiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function isValidReceipt(receipt) {
  return typeof receipt === 'string' && RECEIPT_PATTERN.test(receipt);
}

function createObservationStore({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.round(ttlMs) : DEFAULT_TTL_MS;
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
  // key 是凭据的 sha256：内存里不保存凭据本身，也不会因为比较原始字符串产生可枚举的差异。
  const entries = new Map();
  let seq = 0;

  const digestOf = (receipt) => crypto.createHash('sha256').update(String(receipt), 'utf8').digest('hex');

  function prune(at) {
    for (const [key, record] of entries) {
      if (!record || record.expiresAt <= at) entries.delete(key);
    }
  }

  function evictOverflow() {
    while (entries.size > cap) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /** 新建一张凭据；返回 {receipt, observation}，observation 是表内的活对象。 */
  function issue() {
    const at = Number(now());
    prune(at);
    const receipt = crypto.randomBytes(16).toString('hex');
    const observation = {
      state: 'pending',
      used: null,
      size: null,
      attempt: 0,
      createdAt: at,
      expiresAt: at + ttl,
      finalized: false,
      seq: (seq += 1),
    };
    entries.set(digestOf(receipt), observation);
    evictOverflow();
    return { receipt, observation };
  }

  /** 放弃未结算尝试的暂存样本。已结束的 HTTP 腿不能改写。 */
  function discardAttempt(observation) {
    if (!observation || observation.finalized) return false;
    observation.used = null;
    observation.size = null;
    return true;
  }

  /** 真正派发新 RPC 才切换尝试；活腿归属由网关单独管理。 */
  function beginAttempt(observation) {
    if (!discardAttempt(observation)) return false;
    observation.attempt = (observation.attempt || 0) + 1;
    return true;
  }

  /**
   * 记录一条属于当前派发的 ACP 原始水位。冻结后、或非法 used 一律忽略
   * （连同该 update 的 size 一起忽略，不沿用旧 size）。
   */
  function note(observation, rawUsed, rawSize) {
    if (!observation || observation.finalized) return false;
    const used = nonNegativeSafeInteger(rawUsed);
    if (used === null) return false;
    observation.used = used;
    // size 只认这一条 update 自己的合法值；缺省或非法就是“没有”，不借用上一条。
    observation.size = positiveSafeInteger(rawSize);
    return true;
  }

  /** 本请求结束：冻结并定状态；重复调用幂等。 */
  function finish(observation) {
    if (!observation) return 'unavailable';
    if (observation.finalized) return observation.state;
    observation.finalized = true;
    observation.state = observation.used === null ? 'unavailable' : 'observed';
    return observation.state;
  }

  /** 只读快照；未知 / 过期 / 非法凭据返回 null。 */
  function read(receipt) {
    if (typeof receipt !== 'string' || receipt.length === 0) return null;
    const at = Number(now());
    prune(at);
    const record = entries.get(digestOf(receipt));
    if (!record) return null;
    const body = { version: VERSION, state: record.finalized ? record.state : 'pending' };
    if (record.used !== null) {
      body.observation = { used: record.used };
      if (record.size !== null) body.observation.size = record.size;
    }
    return body;
  }

  function size() {
    prune(Number(now()));
    return entries.size;
  }

  /** 仅供测试：返回表内记录的浅拷贝（不含凭据、prompt、session 等任何文本）。 */
  function inspect(receipt) {
    const record = entries.get(digestOf(receipt));
    return record ? { ...record } : null;
  }

  function clear() {
    entries.clear();
  }

  return { issue, beginAttempt, discardAttempt, note, finish, read, size, inspect, clear, currentSeq: () => seq, ttl, cap };
}

module.exports = {
  createObservationStore,
  isLoopbackAddress,
  isValidReceipt,
  nonNegativeSafeInteger,
  positiveSafeInteger,
  RECEIPT_PATTERN,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  OBSERVATION_VERSION: VERSION,
};
