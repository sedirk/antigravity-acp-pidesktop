'use strict';

// Shared, pure context serialization. No transcript probing, host patching or model calls.
const SUMMARY_CHARS = 108000;
const SUMMARY_BYTES = 116000;
const isSystemRole = role => role === 'system' || role === 'developer';
const contentText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(p => typeof p?.text === 'string' ? p.text : '').join('\n')
    : value == null ? '' : JSON.stringify(value);
const canonicalizeText = text => contentText(text).toWellFormed().replace(/\uFFFD/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const isCompactionSummary = text => /^(?:# Resuming from a compaction|The conversation history before this point was compacted|### Summary of Previous Conversation)/.test(String(text || '').trimStart());
const isCallback = text => /^The following subagents have finished\b/.test(String(text || '').trimStart());
const isDelivery = m => Boolean(m && ((m.role === 'user' && isCallback(contentText(m.content))) || (m.role === 'tool' && /(?:^|[.:/])Task(?:Wait)?$/.test(m.toolName || ''))));
const isHumanRequest = m => m?.role === 'user' && !isCompactionSummary(contentText(m.content)) && !isCallback(contentText(m.content)) && !/^Attached images?(?:\(s\))? from tool results?:?$/i.test(contentText(m.content).trim());
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
    const text = clipText(canonicalizeText(raw), list.length === 0 ? 6000 : 1200);
    if (text && !list.includes(text)) list.push(text);
  }
  // Pin the original goal and first key turns; evict the middle, never the head.
  while (list.length > 64 || !fits(list.join('\n\n'), 24000, 32000)) list.splice(Math.min(4, list.length - 2), 1);
  return list;
}

function userTimeline(messages, previous = [], append = false) {
  const list = Array.isArray(messages) ? messages : [];
  const keepPrevious = append || list.some(m => m?.role === 'user' && isCompactionSummary(contentText(m.content)));
  return boundUserTimeline([...(keepPrevious ? previous : []), ...list.filter(isHumanRequest).map(m => contentText(m.content))]);
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
    const kept = [], seen = new Set(); let dropped = 0, size = 0;
    for (const row of body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const link = /\]\(<?([^>]+?)>?\)$/.exec(row);
      const file = (link ? link[1] : row.replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')).replace(/\\/g, '/');
      const normalized = file.toLowerCase();
      const internal = /(?:\.gemini\/antigravity-acp\/brain(?:\/|$)|\.pi-desktop\/scratch(?:\/|$)|mcp\/pi-bridge(?:\/|$)|\$\{?(?:env:)?pi_scratch_dir\}?)/i.test(normalized);
      const absolute = /^(?:[a-z]:\/|\/)/i.test(normalized);
      const outside = roots.length > 0 && absolute && !roots.some(root => normalized === root || normalized.startsWith(root + '/'));
      if (internal || outside || /^\.\.(?:\/|$)/.test(normalized) || seen.has(normalized) || kept.length >= 40 || size + row.length > 4000) { dropped++; continue; }
      kept.push(row); seen.add(normalized); size += row.length + 1;
    }
    if (dropped) kept.push(`[文件清单已过滤或去重 ${dropped} 项；正文与任务状态未按文件预算裁剪]`);
    return `<${tag}>\n${kept.join('\n')}\n</${tag}>`;
  });
}

function formatMessage(m, itemCap = Infinity) {
  const role = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? (m.toolName ? `Tool (${m.toolName})` : 'Tool') : isCallback(contentText(m.content)) ? 'Subagent completion' : 'User';
  const shorten = (text, label) => clipText(text, itemCap, Infinity, label) || (text ? '[...' + label + '...]' : '');
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
const formatGroup = (group, cap = 8000) => group.map(m => formatMessage(m, cap)).filter(Boolean).join('\n\n');

function boundDeliveries(items = []) {
  const result = [...new Set((Array.isArray(items) ? items : []).filter(s => typeof s === 'string' && s.trim()))].slice(-8);
  // Reports are complete units. Do not claim success after silently clipping their middles.
  while (result.length > 2 && !fits(result.join('\n\n'), 96000, 112000)) result.shift();
  if (!fits(result.join('\n\n'), 96000, 112000)) throw contextOverflow();
  return result;
}
function collectDeliveries(messages, previous = []) {
  return boundDeliveries([...previous, ...messageGroups(messages).filter(g => g.some(isDelivery)).map(g => formatGroup(g, Infinity))]);
}

function recentContext(messages, chars, bytes = Infinity, maxGroups = 18, itemCap = 8000) {
  const groups = messageGroups(messages).filter(g => !g.some(isDelivery));
  const selected = [];
  for (let i = groups.length - 1; i >= 0 && selected.length < maxGroups; i--) {
    let block = formatGroup(groups[i], itemCap);
    if (!block) continue;
    if (selected.length === 0 && !fits(block, chars, bytes)) {
      // Reduce result bodies proportionally, not by slicing away their paired call headers.
      const units = groups[i].reduce((n, m) => n + 1 + (m.toolCalls?.length || 0), 0);
      const cap = Math.max(0, Math.floor(Math.min(chars, bytes / 3) / units) - 300);
      block = formatGroup(groups[i], cap);
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
  const lastText = isHumanRequest(last) ? formatMessage(last, 24000) : '';
  const protectedText = [...parts, lastText].filter(Boolean).join('\n\n');
  if (!fits(protectedText, SUMMARY_CHARS - 200, SUMMARY_BYTES - 200)) throw contextOverflow();
  const history = conv.filter(m => !isHumanRequest(m) && !isCompactionSummary(m.content));
  const recent = recentContext(history, SUMMARY_CHARS - protectedText.length - 200, SUMMARY_BYTES - Buffer.byteLength(protectedText) - 200, Infinity, 4500);
  if (recent) parts.push(`<conversation_history>\n${recent}\n</conversation_history>`);
  if (lastText) parts.push(lastText);
  const out = parts.filter(Boolean).join('\n\n');
  if (!fits(out, SUMMARY_CHARS, SUMMARY_BYTES)) throw contextOverflow();
  return out;
}

module.exports = {
  contentText, canonicalizeText, isSystemRole, isCompactionSummary, isCallback, isDelivery, isHumanRequest,
  clipText, boundUserTimeline, userTimeline, workspaceRoots, filterSummaryFiles,
  formatMessage, messageGroups, recentContext, boundDeliveries, collectDeliveries, flattenSummarization,
};
