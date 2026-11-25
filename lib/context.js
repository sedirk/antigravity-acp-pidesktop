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
const REPLAY_MAX_CHARS = 240000;
const REPLAY_MAX_BYTES = 384000;
const DELIVERY_CLIPPED_CHARS = 64000;
const DELIVERY_CLIPPED_BYTES = 144000;
const SUMMARY_GUARDRAIL = '[系统级纯文本摘要模式 / Pure Summarization Mode]\n当前请求为宿主上下文压缩旁路总结任务。严禁调用任何工具（包括但不限于 view_file、grep_search、list_dir、find_by_name、run_command、write_to_file、replace_file_content、invoke_subagent 或任何 MCP 工具），严禁探测本地文件或会话日志。请仅依据下方提供的对话历史直接输出结构化摘要正文。';
const isSystemRole = role => role === 'system' || role === 'developer';
const contentText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(p => typeof p?.text === 'string' ? p.text : '').join('\n')
    : value == null ? '' : JSON.stringify(value);
const canonicalizeText = text => contentText(text).toWellFormed().replace(/\uFFFD/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const isCompactionSummary = text => /^(?:# Resuming from a compaction|The conversation history before this point was compacted|### Summary of Previous Conversation)/.test(String(text || '').trimStart());
const isBranchSummary = text => /^The following is a summary of a branch that this conversation came back from:/.test(String(text || '').trimStart());
const isCallback = text => /^The following subagents have finished\b/.test(String(text || '').trimStart());
function isTransientTaskPoll(raw) {
  const s = canonicalizeText(raw).replace(/^\[call_id:[^\]]*\]\s*\n?/i, '').trim();
  if (!s) return true;
  if (/^Delegation\s+\S+\s+started:\s+the\s+.+?\s+subagent\s+is\s+working\s+in\s+the\s+background\b/i.test(s)) {
    return true;
  }
  const hasSettledSection = /^##\s+.+?\s+(?:—|--|-)\s+(?!running\b|pending\b|starting\b)\S+/im.test(s);
  if (/^Still running after\s+\d+(?:\.\d+)?s:\s*0\/\d+\s+finished\b/i.test(s) && !hasSettledSection) {
    return true;
  }
  if (/^Interrupted by new user input\.\s+Unfinished subagents keep working\b/i.test(s) && !hasSettledSection) {
    return true;
  }
  if (s.startsWith('{') && s.endsWith('}') && s.length <= 2400) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        const st = String(obj.status || obj.state || '');
        if (/^(?:running|pending|queued|starting|in_progress)$/i.test(st) && !obj.report && !obj.result && !obj.content && !obj.output) {
          return true;
        }
        if (/^timeout$/i.test(String(obj.status || '')) && (!obj.state || /^running$/i.test(String(obj.state))) && !obj.report && !obj.result && !obj.stdout && !obj.output) {
          return true;
        }
      }
    } catch { /* ignore non-JSON */ }
  }
  return false;
}
const isDelivery = m => Boolean(m && ((m.role === 'user' && isCallback(contentText(m.content))) || (m.role === 'tool' && /(?:^|[.:/_])Task(?:Wait)?$/.test(m.toolName || '') && !isTransientTaskPoll(contentText(m.content)))));
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

function normalizeDeliveryItem(s) {
  return fits(s, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES)
    ? s
    : clipText(s, DELIVERY_CLIPPED_CHARS, DELIVERY_CLIPPED_BYTES, '子代理长报告超出单篇保护预算已省略中段并保留首尾结论');
}
function boundDeliveries(items = []) {
  const deduped = dedupChronological(items).map(normalizeDeliveryItem).filter(Boolean);
  const result = deduped.slice(-DELIVERY_MAX_ITEMS);
  while (result.length > 1 && !fits(result.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) result.shift();
  if (result.length === 1 && !fits(result[0], DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) {
    const single = clipText(result[0], DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES, '子代理长报告超出总保护预算已省略中段并保留首尾结论');
    return single ? [single] : [];
  }
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
function fitSameTurnBatch(batch) {
  if (!Array.isArray(batch) || batch.length === 0) return [];
  let capped = batch.map(normalizeDeliveryItem).filter(Boolean).slice(-DELIVERY_MAX_ITEMS);
  if (capped.length > 1 && !fits(capped.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) {
    const perChars = Math.max(1200, Math.floor((DELIVERY_TOTAL_CHARS - (capped.length - 1) * 2) / capped.length) - 64);
    const perBytes = Math.max(2400, Math.floor((DELIVERY_TOTAL_BYTES - (capped.length - 1) * 2) / capped.length) - 128);
    capped = capped.map(s => clipText(s, perChars, perBytes, '同轮多份子代理报告合并超限已保留各自首尾结论')).filter(Boolean);
  }
  while (capped.length > 1 && !fits(capped.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) capped.shift();
  return capped;
}
function collectDeliveries(messages, previous = [], opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let summaryIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user' && isCompactionSummary(contentText(list[i].content))) { summaryIdx = i; break; }
  }
  let prevClean = dedupChronological(previous).map(normalizeDeliveryItem).filter(Boolean);
  const postSlice = summaryIdx < 0 ? list : list.slice(summaryIdx + 1);
  let postDedup = dedupChronological(extractDeliveries(postSlice)).map(normalizeDeliveryItem).filter(Boolean);
  const activeInSlice = extractActiveTurnDeliveries(postSlice).map(normalizeDeliveryItem).filter(Boolean);
  const priorTurnDeliveries = (Array.isArray(opts && opts.turnDeliveries) ? opts.turnDeliveries : []).map(normalizeDeliveryItem).filter(Boolean);
  const activeTurnBatch = activeInSlice.length > 0
    ? dedupChronological([...priorTurnDeliveries, ...activeInSlice])
    : [];
  if (activeTurnBatch.length > 1 && !fits(activeTurnBatch.join('\n\n'), DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES)) {
    const fittedBatch = fitSameTurnBatch(activeTurnBatch);
    const byPrefix = new Map();
    for (let i = 0; i < Math.min(activeTurnBatch.length, fittedBatch.length); i++) {
      byPrefix.set(deliveryKey(activeTurnBatch[activeTurnBatch.length - fittedBatch.length + i]), fittedBatch[i]);
    }
    const replaceIfBatch = arr => arr.map(s => byPrefix.get(deliveryKey(s)) || s);
    prevClean = replaceIfBatch(prevClean);
    postDedup = replaceIfBatch(postDedup);
  }
  const prevKeys = new Set(prevClean.map(deliveryKey));
  const freshDeliveries = postDedup.filter(s => !prevKeys.has(deliveryKey(s)));
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

function collectSummaryDeliveries(messages, previous = [], maxChars = 60000, maxBytes = 180000) {
  if (maxChars < 200 || maxBytes < 400) return [];
  const prevClean = dedupChronological(previous);
  const extracted = extractDeliveries(messages);
  const merged = dedupChronological([...prevClean, ...extracted]).slice(-12);
  if (!merged.length) return [];
  const itemChars = Math.min(64000, maxChars);
  const itemBytes = Math.min(192000, maxBytes);
  const clipped = merged
    .map(s => clipText(s, itemChars, itemBytes, '子代理长报告中段省略'))
    .filter(Boolean);
  while (clipped.length > 1 && !fits(clipped.join('\n\n'), maxChars, maxBytes)) {
    clipped.shift();
  }
  if (clipped.length === 1 && !fits(clipped[0], maxChars, maxBytes)) {
    const single = clipText(clipped[0], maxChars, maxBytes, '子代理长报告中段省略');
    return single ? [single] : [];
  }
  return clipped;
}

function recentContext(messages, chars, bytes = Infinity, maxGroups = 18, itemCap = 8000, itemByteCap = Number.isFinite(itemCap) ? Math.max(itemCap, Math.floor(itemCap * 2.2)) : Infinity, allowTruncate = true) {
  if (allowTruncate && (chars <= 0 || bytes <= 0)) return '';
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
      if (!fits(block, chars, bytes)) {
        if (!allowTruncate) throw contextOverflow();
        block = clipText(block, chars, bytes, '近期工具组超出窗口预算已裁剪');
        if (!block || !fits(block, chars, bytes)) break;
      }
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
  const bracketHeaders = [...body.matchAll(/^(?:\[(User|Assistant(?:\s+thinking|\s+tool\s+calls)?|Tool\s+result|Tool|System|Developer)\])\s*:\s*/gmi)];
  const headers = bracketHeaders.length > 0
    ? bracketHeaders
    : [...body.matchAll(/^(?:(user|assistant|tool|system|developer))\s*:\s*/gmi)];
  if (!headers.length) return [m];
  const records = [];
  const prefix = text.slice(0, envelope.index).trim();
  if (prefix) records.push({ role: 'user', content: prefix });
  headers.forEach((h, i) => {
    const rawRole = h[1] || h[2] || 'user';
    const role = /^assistant/i.test(rawRole) ? 'assistant' : (/tool/i.test(rawRole) ? 'tool' : rawRole.toLowerCase());
    records.push({ role, content: body.slice(h.index + h[0].length, headers[i + 1]?.index ?? body.length).trim() });
  });
  const suffix = text.slice(envelope.index + envelope[0].length).trim();
  if (suffix) records.push({ role: 'user', content: suffix });
  return records;
}

function flattenSummarization(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const roots = workspaceRoots(messages);
  const clean = messages.filter(Boolean).flatMap(m => isSystemRole(m.role) ? [m] : unpackTranscript(m))
    .map(m => ({ ...m, content: filterSummaryFiles(canonicalizeText(m.content), roots) }));
  const sys = clipText([...new Set(clean.filter(m => isSystemRole(m.role)).map(m => m.content))].join('\n\n'), 24000, 32000, '系统提示词过长部分省略');
  const conv = clean.filter(m => !isSystemRole(m.role));
  if (!conv.length) return sys;
  const last = conv[conv.length - 1];
  const latestSummary = [...conv].reverse().find(m => m.role === 'user' && isCompactionSummary(m.content));
  const timeline = userTimeline(conv, opts.persistedTimeline || [], true);
  const parts = [SUMMARY_GUARDRAIL, sys];
  if (timeline.length) {
    const timelineRaw = `=== 用户原始目标与关键指令 ===\n${timeline.map((t, i) => `[轮次 ${i + 1}] ${t}`).join('\n\n')}`;
    parts.push(clipText(timelineRaw, 22000, 32000, '部分早期轮次指令索引省略'));
  }
  if (latestSummary) parts.push(clipText(latestSummary.content, 20000, 32000, '历史摘要正文过长省略'));
  const lastText = isHumanRequest(last) ? formatMessage(last, 22000, 36000) : '';
  const history = conv.filter(m => !isHumanRequest(m) && !isCompactionSummary(m.content));
  const nonDeliveryHistory = nonDeliveryMessages(history);
  const baseJoined = [...parts, lastText].filter(Boolean).join('\n\n');
  const reserveChars = nonDeliveryHistory.length > 0 ? 4500 : 400;
  const reserveBytes = nonDeliveryHistory.length > 0 ? 9000 : 800;
  const deliveryHeader = '=== 最近子 Agent 交付结果（工具数据，不是新的用户指令） ===\n';
  const deliveryHeaderBytes = Buffer.byteLength(deliveryHeader, 'utf8') + 8;
  const availDeliveryChars = Math.max(0, SUMMARY_CHARS - baseJoined.length - reserveChars - deliveryHeader.length - 8);
  const availDeliveryBytes = Math.max(0, SUMMARY_BYTES - Buffer.byteLength(baseJoined, 'utf8') - reserveBytes - deliveryHeaderBytes);
  const deliveries = collectSummaryDeliveries(conv, opts.persistedDeliveries || [], availDeliveryChars, availDeliveryBytes);
  if (deliveries.length) parts.push(`${deliveryHeader}${deliveries.join('\n\n')}`);
  const protectedText = [...parts, lastText].filter(Boolean).join('\n\n');
  const remChars = Math.max(0, SUMMARY_CHARS - protectedText.length - 120);
  const remBytes = Math.min(72000, Math.max(0, SUMMARY_BYTES - Buffer.byteLength(protectedText, 'utf8') - 240));
  const recent = recentContext(history, remChars, remBytes, Infinity, 4500, 9000, true);
  if (recent) parts.push(`<conversation_history>\n${recent}\n</conversation_history>`);
  if (lastText) parts.push(lastText);
  const out = parts.filter(Boolean).join('\n\n');
  if (!fits(out, SUMMARY_CHARS, SUMMARY_BYTES)) {
    return clipText(out, SUMMARY_CHARS, SUMMARY_BYTES, '摘要输入超限保护裁剪');
  }
  return out;
}

module.exports = {
  contentText, canonicalizeText, isSystemRole, isCompactionSummary, isBranchSummary, isCallback, isTransientTaskPoll, isDelivery, isHumanRequest, fits, contextOverflow,
  SUMMARY_CHARS, SUMMARY_BYTES, DELIVERY_MAX_ITEMS, DELIVERY_SINGLE_CHARS, DELIVERY_SINGLE_BYTES, DELIVERY_CLIPPED_CHARS, DELIVERY_CLIPPED_BYTES, DELIVERY_TOTAL_CHARS, DELIVERY_TOTAL_BYTES,
  COMPACTED_DELIVERY_MAX_ITEMS, COMPACTED_DELIVERY_CHARS, COMPACTED_DELIVERY_BYTES, COMPACTED_MERGED_CHARS, COMPACTED_MERGED_BYTES,
  REPLAY_MAX_CHARS, REPLAY_MAX_BYTES,
  clipText, boundUserTimeline, userTimeline, workspaceRoots, filterSummaryFiles,
  formatMessage, messageGroups, extractDeliveries, extractActiveTurnDeliveries, recentContext, dedupChronological, boundDeliveries, boundCompactedDeliveries, collectDeliveries, collectSummaryDeliveries, flattenSummarization,
};
