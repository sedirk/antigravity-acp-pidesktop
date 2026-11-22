'use strict';

// Shared, pure context serialization. No transcript probing, host patching or model calls.
const SUMMARY_CHARS = 108000;
const SUMMARY_BYTES = 324000;
const DELIVERY_MAX_ITEMS = 8;
const DELIVERY_SINGLE_CHARS = 96000;
const DELIVERY_SINGLE_BYTES = 216000;
const DELIVERY_TOTAL_CHARS = 96000;
const DELIVERY_TOTAL_BYTES = 216000;
const COMPACTED_DELIVERY_MAX_ITEMS = 2;
const COMPACTED_DELIVERY_CHARS = 32000;
const COMPACTED_DELIVERY_BYTES = 96000;
const COMPACTED_MERGED_CHARS = 48000;
const COMPACTED_MERGED_BYTES = 128000;
const REPLAY_MAX_CHARS = 196000;
const REPLAY_MAX_BYTES = 232000;
const isSystemRole = role => role === 'system' || role === 'developer';
const contentText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(p => typeof p?.text === 'string' ? p.text : '').join('\n')
    : value == null ? '' : JSON.stringify(value);
const canonicalizeText = text => contentText(text).toWellFormed().replace(/\uFFFD/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const isCompactionSummary = text => /^(?:# Resuming from a compaction|The conversation history before this point was compacted|### Summary of Previous Conversation)/.test(String(text || '').trimStart());
const isBranchSummary = text => /^The following is a summary of a branch that this conversation came back from:/.test(String(text || '').trimStart());
const isCallback = text => /^The following subagents have finished\b/.test(String(text || '').trimStart());
const isDelivery = m => Boolean(m && ((m.role === 'user' && isCallback(contentText(m.content))) || (m.role === 'tool' && /(?:^|[.:/_])Task(?:Wait)?$/.test(m.toolName || ''))));
const isHumanRequest = m => m?.role === 'user' && !isCompactionSummary(contentText(m.content)) && !isBranchSummary(contentText(m.content)) && !isCallback(contentText(m.content)) && !/^Attached images?(?:\(s\))? from tool results?:?$/i.test(contentText(m.content).trim());
const fits = (s, chars, bytes) => s.length <= chars && Buffer.byteLength(s, 'utf8') <= bytes;

function contextOverflow() {
  return Object.assign(new Error('上下文保护区超出安全预算；已拒绝静默截断用户目标、工具因果组或子代理报告。请减少单次交付内容后重试。'), { code: 'CONTEXT_BUDGET_EXCEEDED' });
}

// Binary search guarantees termination even for a tiny UTF-8 budget; never split surrogate pairs.
function clipText(value, chars, bytes = Infinity, label = '中间历史输出省略') {
  const text = contentText(value);
  chars = Math.max(0, Math.floor(chars)); bytes = Math.max(0, bytes);
  if (fits(text, chars, bytes)) return text;
  const marker = `\n[...${label}...]\n`;
  if (!fits(marker, chars, bytes)) return '';
  const slice = n => {
    const head = Math.ceil(n * 0.55), tail = n - head;
    return text.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') + marker + (tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : '');
  };
  let low = 0, high = Math.min(text.length, chars);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(slice(mid), chars, bytes)) low = mid; else high = mid - 1;
  }
  return slice(low);
}

function boundUserTimeline(items = []) {
  const list = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (typeof raw !== 'string' || !isHumanRequest({ role: 'user', content: raw })) continue;
    const text = clipText(canonicalizeText(raw), list.length === 0 ? 6000 : 1200, list.length === 0 ? 14000 : 3200);
    if (text && !list.includes(text)) list.push(text);
  }
  // Pin the original goal and first key turns; evict the middle, never the head.
  while (list.length > 64 || !fits(list.join('\n\n'), 24000, 32000)) list.splice(Math.min(4, list.length - 2), 1);
  return list;
}

function userTimeline(messages, previous = [], append = false) {
  const list = Array.isArray(messages) ? messages : [];
  const humanItems = list.filter(isHumanRequest).map(m => contentText(m.content));
  const keepPrevious = append || humanItems.length === 0 || list.some(m => m?.role === 'user' && isCompactionSummary(contentText(m.content)));
  return boundUserTimeline([...(keepPrevious ? previous : []), ...humanItems]);
}

function workspaceRoots(messages) {
  const roots = [];
  for (const m of messages || []) if (isSystemRole(m?.role)) {
    for (const match of contentText(m.content).matchAll(/(?:Primary root|Additional root|Workspace root|Current working directory|工作目录)\s*[:=]\s*([^\r\n]+)/gi)) {
      roots.push(match[1].trim().replace(/^[`"']|[`"']$/g, '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase());
    }
  }
  return roots;
}

function filterSummaryFiles(text, roots = []) {
  return contentText(text).replace(/<(read-files|modified-files)>\s*([\s\S]*?)<\/\1>/gi, (_, tag, body) => {
    const kept = [], seen = new Set(); let dropped = 0, size = 0, byteSize = 0;
    for (const row of body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const link = /\]\(<?([^>]+?)>?\)$/.exec(row);
      const file = (link ? link[1] : row.replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')).replace(/\\/g, '/');
      const normalized = file.toLowerCase();
      const internal = /(?:\.gemini\/antigravity-acp\/brain(?:\/|$)|\.pi-desktop\/scratch(?:\/|$)|mcp\/pi-bridge(?:\/|$)|\$\{?(?:env:)?pi_scratch_dir\}?)/i.test(normalized);
      const absolute = /^(?:[a-z]:\/|\/)/i.test(normalized);
      const outside = roots.length > 0 && absolute && !roots.some(root => normalized === root || normalized.startsWith(root + '/'));
      const rowBytes = Buffer.byteLength(row, 'utf8');
      if (internal || outside || /^\.\.(?:\/|$)/.test(normalized) || seen.has(normalized) || kept.length >= 40 || size + row.length > 4000 || byteSize + rowBytes > 8000) { dropped++; continue; }
      kept.push(row); seen.add(normalized); size += row.length + 1; byteSize += rowBytes + 1;
    }
    if (dropped) kept.push(`[文件清单已过滤或去重 ${dropped} 项；正文与任务状态未按文件预算裁剪]`);
    return `<${tag}>\n${kept.join('\n')}\n</${tag}>`;
  });
}

function formatMessage(m, itemCap = Infinity, itemByteCap = Number.isFinite(itemCap) ? Math.max(itemCap, Math.floor(itemCap * 2.2)) : Infinity) {
  const rawText = contentText(m.content);
  const role = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? (m.toolName ? `Tool (${m.toolName})` : 'Tool') : isCallback(rawText) ? 'Subagent completion' : isBranchSummary(rawText) ? 'Branch summary' : 'User';
  const shorten = (text, label) => clipText(text, itemCap, itemByteCap, label) || (text ? '[...' + label + '...]' : '');
  const body = shorten(canonicalizeText(m.content), '中间历史输出省略');
  const calls = (m.toolCalls || []).map(c => `Tool call ${c.name || '(unknown)'} [${c.id || '(no id)'}]: ${shorten(contentText(c.arguments), '工具参数中段省略')}`).join('\n');
  const id = m.role === 'tool' && m.toolCallId ? `[call_id: ${m.toolCallId}]\n` : '';
  return body || calls || id ? `${role}:\n${id}${[body, calls].filter(Boolean).join('\n')}` : '';
}

// Calls and their results are atomic window units, including parallel calls and async reports.
function messageGroups(messages) {
  const groups = [], calls = new Map();
  for (const m of messages || []) {
    if (!m || isSystemRole(m.role)) continue;
    let group = m.role === 'tool' && m.toolCallId ? calls.get(m.toolCallId) : null;
    if (!group) { group = []; groups.push(group); }
    group.push(m);
    for (const call of m.toolCalls || []) if (call.id) calls.set(call.id, group);
  }
  return groups;
}
const formatGroup = (group, cap = 8000, byteCap = Number.isFinite(cap) ? Math.max(cap, Math.floor(cap * 2.2)) : Infinity) => group.map(m => formatMessage(m, cap, byteCap)).filter(Boolean).join('\n\n');

const deliveryKey = s => canonicalizeText(s).replace(/^(?:Subagent completion:\s*\n)+/i, '');

function dedupChronological(items = []) {
  const seen = new Set(), out = [];
  const arr = Array.isArray(items) ? items : [];
  for (let i = 0; i < arr.length; i++) {
    const s = typeof arr[i] === 'string' ? arr[i].trim() : '';
    if (!s) continue;
    const key = deliveryKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function extractDeliveries(slice = []) {
  const list = Array.isArray(slice) ? slice : [];
  const callById = new Map();
  const out = [];
  for (const m of list) {
    if (!m || isSystemRole(m.role)) continue;
    if (Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (c && c.id) {
          callById.set(c.id, { call: c, content: m.toolCalls.length === 1 ? m.content : '' });
        }
      }
    }
    if (m.role === 'user' && isCallback(contentText(m.content))) {
      const formatted = formatMessage(m, Infinity, Infinity);
      if (formatted) out.push(formatted);
    } else if (m.role === 'tool' && isDelivery(m)) {
      const paired = (m.toolCallId && callById.get(m.toolCallId)) || (m.pairedCall ? { call: m.pairedCall, content: '' } : null);
      const group = paired
        ? [{ role: 'assistant', content: paired.content, toolCalls: [paired.call] }, m]
        : [m];
      const formatted = formatGroup(group, Infinity, Infinity);
      if (formatted) out.push(formatted);
    }
  }
  return out;
}

function nonDeliveryMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const completedDeliveryCallIds = new Set(
    list.filter(m => m?.role === 'tool' && isDelivery(m) && m.toolCallId).map(m => m.toolCallId),
  );
  const out = [];
  for (const m of list) {
    if (!m || isDelivery(m)) continue;
    if (completedDeliveryCallIds.size > 0 && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const keptCalls = m.toolCalls.filter(c => !c?.id || !completedDeliveryCallIds.has(c.id));
      if (keptCalls.length === 0 && !canonicalizeText(m.content)) continue;
      if (keptCalls.length !== m.toolCalls.length) { out.push({ ...m, toolCalls: keptCalls }); continue; }
    }
    out.push(m);
  }
  return out;
}

function boundDeliveries(items = []) {
  const deduped = dedupChronological(items);
  // Validate each uncompacted delivery individually before any count/window eviction so oversized reports never vanish silently.
  for (const s of deduped) if (!fits(s, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES)) throw contextOverflow();
  const result = deduped.slice(-DELIVERY_MAX_ITEMS);
  // Reports are complete units. Do not claim success after silently clipping their middles.
  while (result.length > 1 && !fits(result.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) result.shift();
  if (!fits(result.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) throw contextOverflow();
  return result;
}
function boundCompactedDeliveries(items = [], maxItems = COMPACTED_DELIVERY_MAX_ITEMS, maxChars = COMPACTED_DELIVERY_CHARS, maxBytes = COMPACTED_DELIVERY_BYTES) {
  // Pre-compaction history is already summarized in <summary>; carry only recent bounded reports so rebuilt sessions stay lean.
  const clean = dedupChronological(items).filter(s => fits(s, maxChars, maxBytes)).slice(-maxItems);
  while (clean.length > 1 && !fits(clean.join('\n\n'), maxChars, maxBytes)) clean.shift();
  return clean;
}
function extractActiveTurnDeliveries(slice) {
  const list = Array.isArray(slice) ? slice : [];
  let turnStart = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || isSystemRole(m.role)) continue;
    if (isHumanRequest(m)) {
      turnStart = i + 1;
      break;
    }
  }
  if (turnStart >= list.length) return [];
  const callById = new Map();
  for (const m of list) {
    if (m && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (c && c.id) callById.set(c.id, { call: c, content: m.toolCalls.length === 1 ? m.content : '' });
      }
    }
  }
  const active = [];
  for (let i = turnStart; i < list.length; i++) {
    const m = list[i];
    if (!m || isSystemRole(m.role)) continue;
    if (m.role === 'user' && isCallback(contentText(m.content))) {
      const formatted = formatMessage(m, Infinity, Infinity);
      if (formatted) active.push(formatted);
    } else if (m.role === 'tool' && isDelivery(m)) {
      const paired = (m.toolCallId && callById.get(m.toolCallId)) || (m.pairedCall ? { call: m.pairedCall, content: '' } : null);
      const group = paired ? [{ role: 'assistant', content: paired.content, toolCalls: [paired.call] }, m] : [m];
      const formatted = formatGroup(group, Infinity, Infinity);
      if (formatted) active.push(formatted);
    }
  }
  return dedupChronological(active);
}
function assertBatchDeliveryBudget(batch) {
  if (!Array.isArray(batch) || batch.length === 0) return;
  for (const s of batch) if (!fits(s, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES)) throw contextOverflow();
  if (batch.length > DELIVERY_MAX_ITEMS) throw contextOverflow();
  if (!fits(batch.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) throw contextOverflow();
}
function collectDeliveries(messages, previous = [], opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let summaryIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user' && isCompactionSummary(contentText(list[i].content))) { summaryIdx = i; break; }
  }
  const prevClean = dedupChronological(previous);
  const prevKeys = new Set(prevClean.map(deliveryKey));
  const postSlice = summaryIdx < 0 ? list : list.slice(summaryIdx + 1);
  const postDedup = dedupChronological(extractDeliveries(postSlice));
  for (const s of postDedup) if (!fits(s, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES)) throw contextOverflow();
  const freshDeliveries = postDedup.filter(s => !prevKeys.has(deliveryKey(s)));
  assertBatchDeliveryBudget(freshDeliveries);
  const activeInSlice = extractActiveTurnDeliveries(postSlice);
  const priorTurnDeliveries = Array.isArray(opts && opts.turnDeliveries) ? opts.turnDeliveries : [];
  const activeTurnBatch = activeInSlice.length > 0
    ? dedupChronological([...priorTurnDeliveries, ...activeInSlice])
    : [];
  assertBatchDeliveryBudget(activeTurnBatch);
  if (summaryIdx < 0) return boundDeliveries([...prevClean, ...postDedup]);
  const postKeys = new Set(postDedup.map(deliveryKey));
  const preExtracted = extractDeliveries(list.slice(0, summaryIdx + 1)).filter(s => !prevKeys.has(deliveryKey(s)));
  const knownPre = dedupChronological([...preExtracted, ...prevClean]);
  const preOnly = knownPre.filter(s => !postKeys.has(deliveryKey(s)));
  const preCarried = boundCompactedDeliveries(preOnly);
  if (!postDedup.length) return preCarried;
  const keptPre = [...preCarried];
  while (keptPre.length > 0 && !fits([...keptPre, ...postDedup].join('\n\n'), COMPACTED_MERGED_CHARS, COMPACTED_MERGED_BYTES)) keptPre.shift();
  const keptPreKeys = new Set(keptPre.map(deliveryKey));
  const orderedKnown = knownPre.filter(s => keptPreKeys.has(deliveryKey(s)) || (postKeys.has(deliveryKey(s)) && prevKeys.has(deliveryKey(s))));
  return boundDeliveries([...orderedKnown, ...freshDeliveries]);
}

function recentContext(messages, chars, bytes = Infinity, maxGroups = 18, itemCap = 8000, itemByteCap = Number.isFinite(itemCap) ? Math.max(itemCap, Math.floor(itemCap * 2.2)) : Infinity) {
  const groups = messageGroups(nonDeliveryMessages(messages));
  const selected = [];
  for (let i = groups.length - 1; i >= 0 && selected.length < maxGroups; i--) {
    let block = formatGroup(groups[i], itemCap, itemByteCap);
    if (!block) continue;
    if (selected.length === 0 && !fits(block, chars, bytes)) {
      // Reduce result bodies proportionally, not by slicing away their paired call headers.
      const units = groups[i].reduce((n, m) => n + 1 + (m.toolCalls?.length || 0), 0);
      const cap = Math.max(0, Math.floor(Math.min(chars, bytes / 3) / units) - 300);
      const bCap = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes / units) - 300) : Infinity;
      block = formatGroup(groups[i], cap, bCap);
      if (!fits(block, chars, bytes)) throw contextOverflow();
    }
    if (!fits([block, ...selected].join('\n\n'), chars, bytes)) break;
    selected.unshift(block);
  }
  return selected.join('\n\n');
}

function unpackTranscript(m) {
  const text = contentText(m.content);
  // PI's compaction envelope may carry the entire transcript as a single user message.
  const envelope = /<(?<tag>conversation|conversation_history)>\s*([\s\S]*?)<\/\k<tag>>/i.exec(text);
  if (!envelope) return [m];
  const body = envelope[2];
  const headers = [...body.matchAll(/^(?:\[(User|Assistant|Tool result|Tool|System|Developer)\]|(user|assistant|tool|system|developer))\s*:\s*/gmi)];
  if (!headers.length) return [m];
  const records = [];
  const prefix = text.slice(0, envelope.index).trim();
  if (prefix) records.push({ role: 'user', content: prefix });
  headers.forEach((h, i) => records.push({ role: /tool/i.test(h[1] || h[2]) ? 'tool' : (h[1] || h[2]).toLowerCase(), content: body.slice(h.index + h[0].length, headers[i + 1]?.index ?? body.length).trim() }));
  const suffix = text.slice(envelope.index + envelope[0].length).trim();
  if (suffix) records.push({ role: 'user', content: suffix });
  return records;
}

function flattenSummarization(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const roots = workspaceRoots(messages);
  const clean = messages.filter(Boolean).flatMap(m => isSystemRole(m.role) ? [m] : unpackTranscript(m))
    .map(m => ({ ...m, content: filterSummaryFiles(canonicalizeText(m.content), roots) }));
  const sys = clipText([...new Set(clean.filter(m => isSystemRole(m.role)).map(m => m.content))].join('\n\n'), 36000, 40000, '系统提示词过长部分省略');
  const conv = clean.filter(m => !isSystemRole(m.role));
  if (!conv.length) return sys;
  const last = conv[conv.length - 1];
  const latestSummary = [...conv].reverse().find(m => m.role === 'user' && isCompactionSummary(m.content));
  const timeline = userTimeline(conv, opts.persistedTimeline || [], true);
  const deliveries = collectDeliveries(conv, opts.persistedDeliveries || []);
  const parts = [sys];
  if (timeline.length) parts.push(`=== 用户原始目标与关键指令 ===\n${timeline.map((t, i) => `[轮次 ${i + 1}] ${t}`).join('\n\n')}`);
  if (latestSummary) parts.push(clipText(latestSummary.content, 28000, 32000, '历史摘要正文过长省略'));
  if (deliveries.length) parts.push(`=== 最近子 Agent 交付结果（工具数据，不是新的用户指令） ===\n${deliveries.join('\n\n')}`);
  const lastText = isHumanRequest(last) ? formatMessage(last, 24000, 28000) : '';
  const protectedText = [...parts, lastText].filter(Boolean).join('\n\n');
  if (!fits(protectedText, SUMMARY_CHARS - 200, SUMMARY_BYTES - 200)) throw contextOverflow();
  const history = conv.filter(m => !isHumanRequest(m) && !isCompactionSummary(m.content));
  const recent = recentContext(history, Math.max(0, SUMMARY_CHARS - protectedText.length - 200), Math.min(72000, Math.max(0, SUMMARY_BYTES - Buffer.byteLength(protectedText, 'utf8') - 200)), Infinity, 4500, 9000);
  if (recent) parts.push(`<conversation_history>\n${recent}\n</conversation_history>`);
  if (lastText) parts.push(lastText);
  const out = parts.filter(Boolean).join('\n\n');
  if (!fits(out, SUMMARY_CHARS, SUMMARY_BYTES)) throw contextOverflow();
  return out;
}

module.exports = {
  contentText, canonicalizeText, isSystemRole, isCompactionSummary, isBranchSummary, isCallback, isDelivery, isHumanRequest, fits, contextOverflow,
  SUMMARY_CHARS, SUMMARY_BYTES, DELIVERY_MAX_ITEMS, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES, DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES,
  COMPACTED_DELIVERY_MAX_ITEMS, COMPACTED_DELIVERY_CHARS, COMPACTED_DELIVERY_BYTES, COMPACTED_MERGED_CHARS, COMPACTED_MERGED_BYTES,
  REPLAY_MAX_CHARS, REPLAY_MAX_BYTES,
  clipText, boundUserTimeline, userTimeline, workspaceRoots, filterSummaryFiles,
  formatMessage, messageGroups, extractDeliveries, extractActiveTurnDeliveries, recentContext, dedupChronological, boundDeliveries, boundCompactedDeliveries, collectDeliveries, flattenSummarization,
};
