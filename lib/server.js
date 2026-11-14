'use strict';

/**
 * OpenAI 兼容 HTTP 层：/v1/models、/v1/chat/completions、/v1/responses、/health。
 *
 * 每条 prompt 通过并发限制器排队；session/update 按 sessionId 路由到对应请求，
 * 因此 limit>1 时并发的两条流不会串台。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMcpServer } = require('./mcp.js');
const { projectTools, toolResultText, toToolCalls, matchToolResult } = require('./bridge.js');
const { createBridgeTurn } = require('./bridge-turn.js');
const { createSessionStore } = require('./session-store.js');

const MAX_BODY = 32 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length), 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(payload);
}

function oaiError(res, status, message, code = 'antigravity_error') {
  json(res, status, { error: { message, type: 'antigravity_acp', code } });
}

/**
 * 统一的 SSE 通道：写头 → `: open` → 定时心跳 → 关闭清理。
 * 与参考实现 dsh-antigravity-acp 的 `#sseOpen` 同构（同一套标准做法），
 * 区别只是这里顺手统计帧数与最后一次写入时刻，供中断诊断用。
 */
function openSse(res, { heartbeatMs = 5000, onAbort = null } = {}) {
  if (!res.headersSent) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    if (res.socket) { try { res.socket.setNoDelay(true); res.socket.setTimeout(0); } catch { /* ignore */ } }
    res.write(': open\n\n');
  }
  const openedAt = Date.now();
  let lastWriteAt = openedAt;
  let frames = 0;
  let seq = 0;
  const write = (text) => {
    if (res.writableEnded) return false;
    try { res.write(text); frames += 1; lastWriteAt = Date.now(); return true; } catch { return false; }
  };
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ping\n\n'); lastWriteAt = Date.now(); } catch { /* ignore */ }
  }, heartbeatMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  res.on('close', stop);
  if (typeof onAbort === 'function') {
    res.on('close', () => {
      if (res.writableEnded) return;
      onAbort({ elapsed: Date.now() - openedAt, frames, gap: Date.now() - lastWriteAt });
    });
  }
  return {
    data: (chunk) => write(`data: ${JSON.stringify(chunk)}\n\n`),
    done: () => write('data: [DONE]\n\n'),
    event: (type, payload) => write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: seq++ })}\n\n`),
    comment: (text) => write(`: ${text}\n\n`),
    stop,
    end: () => { stop(); if (!res.writableEnded) res.end(); },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        try { req.pause(); } catch { /* ignore */ }
        reject(Object.assign(new Error('请求体过大，超过大小限制'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (typeof c === 'string') return c;
    if (!c || typeof c !== 'object') return '';
    if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') return c.text || '';
    if (c.type === 'image_url' || c.type === 'input_image') return '';
    return '';
  }).join('');
}

/** 从一条消息里收集图片 URL（data: 或 http(s)），供 ACP 图片块使用。 */
function collectImageUrls(content) {
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image_url') {
      const value = part.image_url;
      urls.push(typeof value === 'string' ? value : (value && value.url) || '');
    } else if (part.type === 'input_image') {
      urls.push(part.image_url || part.url || '');
    }

  }
  return urls.filter((u) => typeof u === 'string' && u.length > 0);
}

/** 从一条消息里收集文档附件（PDF 等）。兼容 Responses 的 input_file、Chat 的 file、Anthropic 的 document。 */
function collectDocuments(content) {
  if (!Array.isArray(content)) return [];
  const docs = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_file' || part.type === 'file') {
      const file = part.file && typeof part.file === 'object' ? part.file : part;
      const name = file.filename || file.name || part.filename || 'attachment';
      const data = typeof file.file_data === 'string' ? file.file_data : (typeof file.data === 'string' ? file.data : '');
      const url = typeof file.file_url === 'string' ? file.file_url : (typeof file.url === 'string' ? file.url : '');
      if (data) docs.push({ name, data });
      else if (url) docs.push({ name, url });
      else if (file.file_id || part.file_id) docs.push({ name, unsupported: 'file_id' });
      continue;
    }
    if (part.type === 'document' && part.source && typeof part.source === 'object') {
      const src = part.source;
      const name = part.name || 'attachment';
      if (src.type === 'base64' && typeof src.data === 'string') docs.push({ name, data: `data:${src.media_type || 'application/pdf'};base64,${src.data}` });
      else if (src.type === 'url' && typeof src.url === 'string') docs.push({ name, url: src.url });
      else if (src.type === 'text' && typeof src.data === 'string') docs.push({ name, inlineText: src.data });
    }
  }
  return docs;
}

/** 取文档字节：data URL、http(s)、file:// 都支持。 */
async function readDocumentBytes(doc, allowedRoots = []) {
  if (doc.inlineText) return { name: doc.name, mimeType: 'text/plain', bytes: Buffer.from(doc.inlineText, 'utf8') };
  const dataUrl = /^data:([^;,]*);base64,([\s\S]+)$/i.exec(doc.data || '');
  if (dataUrl) {
    const bytes = Buffer.from(dataUrl[2].replace(/\s+/g, ''), 'base64');
    return bytes.length > 0 ? { name: doc.name, mimeType: dataUrl[1] || 'application/pdf', bytes } : null;
  }
  const source = doc.url && !/^data:/i.test(doc.url) ? doc.url : (doc.data && !/^data:/i.test(doc.data) ? doc.data : '');
  if (!source) return null;
  try {
    if (/^file:\/\//i.test(source)) {
      const local = require('node:url').fileURLToPath(source);
      if (!fs.existsSync(local) || !fs.statSync(local).isFile()) return null;
      if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
        const resolved = path.resolve(local);
        const inBounds = allowedRoots.some((r) => {
          if (!r) return false;
          const rootResolved = path.resolve(r);
          const rel = path.relative(rootResolved, resolved);
          return !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (!inBounds) return null;
      }
      return { name: path.basename(local), mimeType: 'application/octet-stream', bytes: fs.readFileSync(local) };
    }
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length > 0 ? { name: doc.name, mimeType: mime, bytes } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** 附件落盘（按内容哈希去重），顺手清掉 7 天前的旧文件。 */
function persistAttachment(dir, doc, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const digest = crypto.createHash('sha256').update(payload.bytes).digest('hex').slice(0, 32);
  const ext = path.extname(payload.name || '') || (payload.mimeType === 'application/pdf' ? '.pdf' : '.bin');
  const file = path.join(dir, `${digest}${ext.slice(0, 12)}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, payload.bytes);
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { file, digest, size: payload.bytes.length };
}

/**
 * 文档 → ACP resource_link。
 * 实测：内联 blob 的 resource 块运行时读不到；给 file:// 的 resource_link 才生效
 * （模型自己读文件，30 秒内答出 PDF 里的口令）。
 */
async function documentBlock(doc, attachmentsDir, allowedRoots = []) {
  if (doc.unsupported === 'file_id') {
    return { block: { type: 'text', text: `（附件 ${doc.name} 以 file_id 形式提供，插件无法从 OpenAI Files 接口取回，已跳过）` }, persisted: null };
  }
  const payload = await readDocumentBytes(doc, allowedRoots);
  if (!payload) {
    return { block: { type: 'text', text: `（附件 ${String(doc.name).slice(0, 60)} 读取失败，已跳过）` }, persisted: null };
  }
  if (payload.mimeType === 'text/plain') {
    return { block: { type: 'text', text: `附件 ${doc.name} 的内容：\n${payload.bytes.toString('utf8').slice(0, 200000)}` }, persisted: null };
  }
  const saved = persistAttachment(attachmentsDir, doc, payload);
  const uri = `file:///${saved.file.replace(/\\/g, '/')}`;
  return {
    block: { type: 'resource_link', uri, name: doc.name, mimeType: payload.mimeType, size: saved.size },
    persisted: saved,
  };
}

/** data: URL 或 http(s) 图片 → ACP 图片内容块。 */
async function imageBlock(url) {
  const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
  if (dataUrl) {
    return { type: 'image', mimeType: dataUrl[1], data: dataUrl[2].replace(/\s+/g, '') };
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) return null;
      return { type: 'image', mimeType: mime, data: buffer.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}

/** 文本 + 图片 + 文档 → ACP prompt 内容块数组。 */
async function buildPromptBlocks(text, urls = [], docs = [], attachmentsDir = path.join(os.tmpdir(), 'antigravity-acp-attachments'), allowedRoots = []) {
  const blocks = [{ type: 'text', text }];
  for (const url of urls) {
    const block = await imageBlock(url);
    if (block) blocks.push(block);
    else blocks.push({ type: 'text', text: `（有一张图片无法读取：${String(url).slice(0, 80)}）` });
  }
  for (const doc of docs) {
    const { block } = await documentBlock(doc, attachmentsDir, allowedRoots);
    if (block) blocks.push(block);
  }
  return blocks;
}

function normalizeMessages(body, { responses = false } = {}) {
  const out = [];
  if (responses && typeof body.instructions === 'string' && body.instructions) out.push({ role: 'system', content: body.instructions });
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) out.push({
      role: (m && m.role) || 'user',
      content: textOf(m && m.content),
      images: collectImageUrls(m && m.content),
      documents: collectDocuments(m && m.content),
      // 工具回填需要保留配对字段，否则无法把结果交回挂起的调用
      toolCallId: (m && m.tool_call_id) || '',
      toolName: (m && m.name) || '',
    });
  }
  if (responses && body.input !== undefined) {
    if (typeof body.input === 'string') out.push({ role: 'user', content: body.input });
    else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === 'string') { out.push({ role: 'user', content: item }); continue; }
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call_output') { out.push({ role: 'tool', content: String(item.output || ''), toolCallId: item.call_id || '' }); continue; }
        if (item.type === 'function_call') continue;
        if (item.type === 'message' || item.role) out.push({ role: item.role || 'user', content: textOf(item.content), images: collectImageUrls(item.content), documents: collectDocuments(item.content) });
        else if (item.type === 'input_text' || item.type === 'text') out.push({ role: 'user', content: item.text || '' });
      }
    }
  }
  return out;
}

function canonicalizeText(text) {
  if (typeof text !== 'string') return '';
  let res = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
  res = res.replace(/[\uFFFD\uD800-\uDFFF]/g, '');
  return res.trim();
}

/**
 * 将多轮历史与最新提问平铺（Flatten），适配无缝切模型与会话重放。
 * 针对超长上下文记忆与压缩（Compaction）的核心设计原则：
 * 1. 结构化隔离：`=== 对话历史 ===` 与 `=== 当前用户请求 ===` 严格物理隔离，杜绝注意力漂移；
 * 2. 压缩摘要优先：若包含 PI-Desktop compaction / summary 节点，丢弃压缩点之前的全部远古死数据；
 * 3. 限制单条历史长度：单条历史消息最大 8,000 字符（工具超长返回智能截断），杜绝单个日志挤爆上下文；
 * 4. 滑动窗口与安全上限：保留系统提示、首条提问与最近高质量多轮（最多 12 轮），总历史控制在 64KB 以内；
 * 5. 最新提问绝对优先：当前用户请求永远完整无缺置于最尾部，不受任何历史削减影响。
 */
function flatten(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (messages.length === 1 || lastUserIdx <= 0) {
    const target = lastUserIdx >= 0 ? messages[lastUserIdx] : messages[messages.length - 1];
    return canonicalizeText(typeof target.content === 'string' ? target.content : JSON.stringify(target.content));
  }

  const historyMessages = messages.slice(0, lastUserIdx);
  const currentMsg = messages[lastUserIdx];
  const currentText = canonicalizeText(typeof currentMsg.content === 'string' ? currentMsg.content : JSON.stringify(currentMsg.content));

  // 1. 寻找最新的 Compaction 摘要锚点
  let compactionIdx = -1;
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const c = typeof historyMessages[i].content === 'string' ? historyMessages[i].content : '';
    if (c.includes('# Resuming from a compaction') || c.includes('<summary>') || c.includes('### Summary of Previous Conversation')) {
      compactionIdx = i;
      break;
    }
  }

  let effectiveHistory = historyMessages;
  if (compactionIdx >= 0) {
    const sys = historyMessages.filter((m) => m && m.role === 'system');
    const afterCompaction = historyMessages.slice(compactionIdx);
    if (afterCompaction.length > 12) {
      // 压缩摘要之后又累积了长对话：保留压缩摘要自身 + 最近 10 条活跃消息
      const compactionMsg = afterCompaction[0];
      const recent = afterCompaction.slice(-10);
      effectiveHistory = [...sys, compactionMsg, ...recent];
    } else {
      effectiveHistory = [...sys, ...afterCompaction];
    }
  } else if (historyMessages.length > 12) {
    const sys = historyMessages.filter((m) => m && m.role === 'system');
    const firstUser = historyMessages.find((m) => m && m.role === 'user');
    const recent = historyMessages.slice(-10);
    const set = new Set([...sys, ...(firstUser ? [firstUser] : []), ...recent]);
    effectiveHistory = historyMessages.filter((m) => set.has(m));
  }

  // 2. 单条历史内容截断防撑爆（限制 8,000 字符，保留头尾）
  const MAX_HISTORY_BLOCK_LEN = 8000;
  const historyBlocks = effectiveHistory.map((m) => {
    const who = m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
    let text = canonicalizeText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    if (text.length > MAX_HISTORY_BLOCK_LEN) {
      const head = text.slice(0, 4000);
      const tail = text.slice(-3800);
      text = `${head}\n\n[...中间历史输出省略 ${text.length - 7800} 字...]\n\n${tail}`;
    }
    return `${who}:\n${text}`;
  }).filter(Boolean);

  // 3. 历史总预算上限控制在 64KB 以内，从最旧的非系统消息开始逐步裁剪
  const MAX_TOTAL_HISTORY_BYTES = 64 * 1024;
  let totalHistoryText = historyBlocks.join('\n\n');
  while (totalHistoryText.length > MAX_TOTAL_HISTORY_BYTES && historyBlocks.length > 2) {
    // 优先移除最旧的非系统消息（保留 index 0 若为 System）
    const removeIdx = historyBlocks[0].startsWith('System:\n') ? 1 : 0;
    historyBlocks.splice(removeIdx, 1);
    totalHistoryText = historyBlocks.join('\n\n');
  }

  return `=== 对话历史 (Conversation Context) ===\n\n${totalHistoryText}\n\n=== 当前用户请求 (Current User Request) ===\n\n${currentText}`;
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last ? last.content : '';
}

/**
 * 会话键 = 对话身份，**不含模型**。
 *
 * 旧实现哈希 `messages.slice(0, -1)`：第 1 轮存 hash([S])，第 2 轮算 hash([S,U1,A1]) 必然不命中，
 * 于是每一轮新建会话——实测每轮白付 7–11 秒预热，还要把全部历史重放一遍。
 * 现在优先用宿主给的会话标识（prompt_cache_key / conversation_id / conversation / metadata），
 * 否则退化为「系统提示 + 首条 user 消息」——这两样在后续轮次里不会变。
 *
 * 模型（含思考档位）刻意不进键：ACP 会话本身与模型无关，模型只是可切换属性。
 * 实测同一会话 carbon-high → 3.8-flash-low → carbon-medium 来回切，暗号照样记得。
 * 把模型算进键的代价是：用户在对话里换模型/换档位就等于换对话，新建会话 + 重放整段历史。
 */
function keyFor(messages, req = {}) {
  const meta = (req && req.metadata) || {};
  const hostKey = String(
    (req && (req.prompt_cache_key || req.conversation_id || req.conversation)) ||
    meta.conversation_id || meta.session_id || meta.chat_id || '',
  ).trim();
  const system = messages.find((m) => m.role === 'system');
  const firstUser = messages.find((m) => m.role === 'user');
  const images = firstUser && Array.isArray(firstUser.images) ? firstUser.images.length : 0;
  const identity = hostKey
    ? `host:${hostKey}`
    : `first:${system ? system.content : ''}|${firstUser ? firstUser.content : ''}|${images}`;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function extractUserPrompts(messages) {
  if (!Array.isArray(messages)) return [];
  const list = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'user') {
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      }
      list.push(text.trim());
    }
  }
  return list;
}

/** 最后一条 user 消息里的图片（ACP 图片块只随这条发出）。 */
function lastUserImages(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last && Array.isArray(last.images) ? last.images : [];
}

/** 最后一条 user 消息里的文档（跟着同一条 prompt 发出）。 */
function lastUserDocs(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last && Array.isArray(last.documents) ? last.documents : [];
}

function finishReason(stopReason) {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

function countTokens(text) {
  const str = String(text || '');
  if (!str) return 0;
  const cjk = (str.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk + Math.max(0, Math.round((str.length - cjk) / 4));
}

/**
 * 组装 usage（OpenAI 形状）。
 *
 * ACP 只发 usage_update{used,size}：这是**运行时真实的累计上下文占用**（实测 11160 → 11643 → …），
 * 没有单次 token 数。旧实现把「本轮发给运行时的文本」估算成 prompt_tokens——会话复用之后那只是
 * 一句增量（甚至是「继续」），于是 PI-Desktop 的上下文标签永远停在 1–2%（宿主读的是
 * `response.usage.input_tokens`，见 openai-responses-shared 的 finalizeResponse）。
 * 现在只要运行时给了真实值，就直接用它当 prompt_tokens；拿不到才退回估算。
 */
function usageFor(promptText, text, thought, stats = null) {
  const estimatedPrompt = countTokens(promptText);
  const realContext = stats && Number.isFinite(stats.contextUsed) && stats.contextUsed > 0 ? stats.contextUsed : 0;
  // 优先：运行时真实占用 → 次选：调用方给的「整段对话」估算 → 最后：本轮增量文本估算
  const prompt = realContext || (stats && stats.estimateContext) || estimatedPrompt;
  const completion = countTokens(text) + countTokens(thought);
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: realContext === 0 };
  if (stats && Number.isFinite(stats.contextUsed)) usage.context_used = stats.contextUsed;
  if (stats && Number.isFinite(stats.contextSize)) usage.context_size = stats.contextSize;
  return usage;
}

/** ACP 的 session/prompt 只吃内容块，这些 OpenAI 采样/工具字段一律不生效，只用来提示用户。 */
const UNSUPPORTED_PARAMS = [
  'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop', 'seed',
  'presence_penalty', 'frequency_penalty', 'logprobs', 'top_logprobs', 'logit_bias',
  'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'verbosity',
];

/** 找出请求里实际带了、但运行时并不支持的参数。 */
function ignoredParams(req) {
  const present = [];
  for (const key of UNSUPPORTED_PARAMS) {
    const value = req[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    present.push(key);
  }
  if (req.text && typeof req.text === 'object' && req.text.format !== undefined) present.push('text.format');
  return present;
}

/** 把「运行时忽略的参数」拼成日志后缀，供 chat / responses 共用。 */
function ignoredFor(req) {
  const ignored = ignoredParams(req);
  return ignored.length ? ` · 运行时忽略 ${ignored.join(',')}` : '';
}

const POLICIES = ['search', 'agent', 'shell', 'all', 'none'];

/** 运行时在「工具做完但没写正文」时会结束回合；同一会话催一次即可，不要换会话重放。 */
const NUDGE_TEXT = '上一轮没有输出正文。请基于已经完成的结果，直接用文字给出最终答复；不要重复已经执行过的操作。';

/** 请求里是否声明了联网搜索工具（PI-Desktop 的「原生联网搜索」勾选会带这个）。 */
function hasWebSearchTool(req) {
  const tools = Array.isArray(req && req.tools) ? req.tools : [];
  return tools.some((tool) => tool && typeof tool === 'object' && String(tool.type || '').startsWith('web_search'));
}

/**
 * 本轮生效的工具权限：
 *   1. 请求自带 tool_policy（自定义字段）→ 用它；
 *   2. 配置是 none，但宿主声明了 web_search → 临时放宽到 search（只放行只读工具）；
 *   3. 其余用配置值。
 */
function policyForRequest(cfgPolicy, req) {
  const explicit = String((req && req.tool_policy) || '').toLowerCase();
  if (POLICIES.includes(explicit)) return { policy: explicit, reason: 'request.tool_policy' };
  const base = POLICIES.includes(cfgPolicy) ? cfgPolicy : 'all';
  if (base === 'none' && hasWebSearchTool(req)) return { policy: 'search', reason: 'request.web_search' };
  return { policy: base, reason: 'config' };
}

/** 数据目录（放 usage.jsonl / sessions.json）：配置文件所在目录，没有配置就退到临时目录。 */
function dataDirOf(config) {
  const source = String((config && config.source) || '');
  return source && source !== '(默认值)' ? path.dirname(source) : path.join(os.tmpdir(), 'antigravity-acp');
}

/** 每次请求追加一行用量统计（JSONL），文件超过 5MB 就轮转一次。 */
function appendUsage(config, record) {
  try {
    const dir = dataDirOf(config);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'usage.jsonl');
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch { /* 记不了就算了，不能影响回答 */ }
}
function createGateway({ acp, limiter, getConfig, log = () => {}, attachmentsPath = '' }) {
  const sessions = new Map();
  const handlers = new Map();
  // 会话足迹：网关/运行时重启后靠它 session/load 接回同一轮对话（只存键与 sessionId）。
  const sessionStore = createSessionStore({ file: path.join(dataDirOf(getConfig()), 'sessions.json'), log });
  sessionStore.load();
  for (const rec of sessionStore.list()) {
    sessions.set(rec.key, {
      sessionId: rec.sessionId,
      model: rec.model,
      touched: rec.touched,
      closed: true,
      inflight: 0,
      bridgeUrl: rec.bridgeUrl,
      restored: true,
      ...(rec.contextUsed > 0 ? { contextUsed: rec.contextUsed } : {}),
      ...(rec.contextSize > 0 ? { contextSize: rec.contextSize } : {}),
    });
  }
  let server = null;
  let port = null;

  /** 工具 kind → 可读动作；ACP 的 title 往往是整条命令文本，压成一行短标签。 */
  const KIND_LABEL = { execute: '运行命令', read: '读文件', edit: '写文件', search: '联网搜索', fetch: '抓网页', other: '子任务' };
  function toolLabel(u) {
    const kind = String((u && u.kind) || 'other');
    const name = KIND_LABEL[kind] || kind;
    let title = String((u && u.title) || '').replace(/\s+/g, ' ').trim();
    // 运行时爱把整条命令塞进 title，还会带 “[Codex] •” 前缀、或把动作名再写一遍
    // （“运行命令: utf8 = …”）。以前这些原样进「思考」栏，几十条几乎一样的命令糊成一片。
    title = title
      .replace(/^(\[[^\]]{1,24}\]\s*[•·:|-]\s*)+/, '')
      .replace(/^[•·:|-]\s*/, '')
      .trim();
    const dupName = new RegExp(`^(?:${name}|工具|Tool)\\s*[:：-]\\s*`, 'i');
    while (dupName.test(title)) title = title.replace(dupName, '').trim();
    if (!title || title === '工具' || title === name) return name;
    return `${name}：${title.length > 48 ? `${title.slice(0, 48)}…` : title}`;
  }

  /**
   * 工具进度行：同一次调用只报一次；连续重复的同一动作合并，结束时补一句重复次数。
   * 以前 tool_call 和 tool_call_update 都发、命令文本原样塞进「思考」栏，几十条几乎一样的命令糊成一片。
   */
  function progressLine(state, u, flushing = false) {
    const closeRepeat = () => {
      if (!state.repeat || state.repeat < 2) return '';
      const line = `  ↳ 上一步重复 ${state.repeat} 次\n`;
      state.repeat = 0;
      return line;
    };
    if (flushing) return closeRepeat();
    if (!u) return '';
    const id = String(u.toolCallId || '');
    if (u.sessionUpdate === 'tool_call_update') {
      if (u.status !== 'failed' || !id || state.failed.has(id)) return '';
      state.failed.add(id);
      return `${closeRepeat()}✖ 失败：${toolLabel(u)}\n`;
    }
    if (u.sessionUpdate !== 'tool_call') return '';
    if (!id || state.calls.has(id)) return '';
    state.calls.add(id);
    const label = toolLabel(u);
    if (label === state.lastLabel) { state.repeat += 1; return ''; }
    const line = `· ${label}\n`;
    state.lastLabel = label;
    return `${closeRepeat()}${line}`;
  }
  let lastRequest = null;
  // 上游把子代理/定时任务放到后台跑时不发 stdout；这里据此避免被活动看门狗误判为卡死。
  const BACKGROUND_TOOL_RE = /invoke_subagent|subagent|schedule|background/i;
  const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'cancelled']);
  function trackBackgroundTool(stats, u) {
    const id = String((u && u.toolCallId) || '');
    if (!id) return;
    if (!stats.bg) stats.bg = new Set();
    if (u.sessionUpdate === 'tool_call') {
      if (BACKGROUND_TOOL_RE.test(String(u.title || ''))) stats.bg.add(id);
    } else if (u.sessionUpdate === 'tool_call_update' && TERMINAL_TOOL_STATUS.has(String(u.status || ''))) {
      stats.bg.delete(id);
    }
    if (stats.bg.size === 0) stats.bgSince = 0;
  }
  /** 一次性诊断：把宿主请求里可能当会话标识的字段打出来（定位「每轮都新会话」）。 */
  function logRequestIds(req, body, tag) {
    try {
      const keys = Object.keys(req || {});
      const meta = (body && body.metadata) || {};
      const hint = [
        `keys=${Object.keys(body || {}).length}`,
        body && body.prompt_cache_key ? `cache=${String(body.prompt_cache_key).slice(0, 24)}` : '',
        body && body.previous_response_id ? `prev=${String(body.previous_response_id).slice(0, 16)}` : '',
        meta.conversation_id ? `conv=${String(meta.conversation_id).slice(0, 24)}` : '',
        req && req['x-session-id'] ? `xs=${String(req['x-session-id']).slice(0, 24)}` : '',
        req && req['x-conversation-id'] ? `xc=${String(req['x-conversation-id']).slice(0, 24)}` : '',
      ].filter(Boolean).join(' · ');
      log(`${tag} 请求标识：${hint || '(无可用标识)'}`);
    } catch { /* 诊断失败不影响主流程 */ }
  }

  let activePrompts = 0;

  // 运行时同一会话上并发 receive_steps() 会直接报
  // `Concurrent receive_steps() calls are not supported on this connection`。
  // 但不同会话之间 ACP 运行时原生完全支持并发调用。
  // 因此串行化锁按 sessionId 独立维护，避免旁路压缩/并发对话被主会话挂起阻塞：
  const sessionPromptChains = new Map();
  const busySessions = new Set();

  async function serializeSessionPrompt(sessionId, fn) {
    const sid = String(sessionId || '__global__');
    const prev = sessionPromptChains.get(sid) || Promise.resolve();
    let release;
    const next = prev.then(() => new Promise((resolve) => { release = resolve; }));
    sessionPromptChains.set(sid, next);
    await prev;
    busySessions.add(sid);
    try {
      return await fn();
    } finally {
      busySessions.delete(sid);
      if (typeof release === 'function') release();
      if (sessionPromptChains.get(sid) === next) {
        sessionPromptChains.delete(sid);
      }
    }
  }
  // 工具回交：把 PI 的工具挂给运行时，调用转成 OpenAI tool_calls 交给宿主执行。
  const bridges = new Map();
  let mcpBridge = null;
  let mcpUrl = '';
  async function ensureBridgeServer() {
    if (mcpBridge) return mcpUrl;
    mcpBridge = createMcpServer({
      listTools: (url = '') => {
        const matched = /[?&]k=([^&#]+)/.exec(String(url || ''));
        const byKey = matched ? bridges.get(decodeURIComponent(matched[1])) : null;
        if (byKey && byKey.tools && byKey.tools.length) return byKey.tools;
        const first = [...bridges.values()].find((b) => b.tools && b.tools.length);
        return first ? first.tools : [];
      },
      callTool: ({ name, args, url, registerCancel }) => parkToolCall(name, args, url, registerCancel),
      log,
    });
    const info = await mcpBridge.listen(0, '127.0.0.1');
    mcpUrl = info.url;
    log(`工具桥 MCP 已启动：${mcpUrl}`);
    return mcpUrl;
  }
  function parkToolCall(name, args, url = '', registerCancel = null) {
    // 按会话键路由：桥接端点是共享的，多个对话同时在线时不能靠「第一个空闲的」
    // 猜目标（错一次就把工具结果回填进别人的对话，还看不出报错）。
    const matched = /[?&]k=([^&#]+)/.exec(String(url || ''));
    const byKey = matched ? bridges.get(decodeURIComponent(matched[1])) : null;
    const target = byKey || [...bridges.values()].find((b) => (!b.parked || b.parked.length === 0) && b.waiting);
    if (!target) return Promise.reject(new Error('没有等待中的桥接轮次'));
    if (!Array.isArray(target.parked)) target.parked = target.parked ? [target.parked] : [];
    const declared = Array.isArray(target.tools) ? target.tools.find((t) => t.name === name) : null;
    const rawName = (declared && declared.rawName) || name;
    return new Promise((resolve) => {
      const entry = { toolCallId: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, name, rawName, args, resolve };
      target.parked.push(entry);
      target.waiting = false;
      if (typeof registerCancel === 'function') {
        registerCancel(() => {
          if (!Array.isArray(target.parked)) return;
          const idx = target.parked.indexOf(entry);
          if (idx >= 0) target.parked.splice(idx, 1);
        });
      }
      if (typeof target.onPark === 'function') target.onPark();
    });
  }
  function clearAllBridges(reason = '运行时或网关已重置') {
    for (const [, b] of bridges) {
      if (b && b.parkTimer) { clearTimeout(b.parkTimer); b.parkTimer = null; }
      const list = b && Array.isArray(b.parked) ? b.parked.splice(0) : [];
      for (const item of list) {
        try { item.resolve({ content: [{ type: 'text', text: reason }], isError: true }); } catch { /* ignore */ }
      }
    }
    bridges.clear();
  }

  const idleSessionMs = () => Math.max(Number(getConfig().idleSessionMinutes) || 10, 1) * 60000;

  // 运行时重启/被杀后，内存里的 sessionId 全部失效，但会话本体在运行时的 brain 目录里：
  // 转成「可 session/load 还原」的足迹，下次同一轮对话能直接接回来；load 失败才退化成新建。
  acp.onExit = () => {
    if (sessions.size > 0) log(`运行时已退出：${sessions.size} 个会话转为可用 session/load 还原`);
    for (const [key, value] of sessions) {
      value.closed = true;
      value.restored = true;
      sessionStore.set(key, { sessionId: value.sessionId, model: value.model, bridgeUrl: value.bridgeUrl, touched: value.touched, contextUsed: value.contextUsed, contextSize: value.contextSize });
    }
    clearAllBridges('ACP 运行时已退出');
    handlers.clear();
    acp.policyBySession.clear();
  };

  /** 运行时的 worker 只有 session/close 才会退；光删本地 map 会泄漏进程（每个都不小）。 */
  async function closeSession(sessionId) {
    if (!sessionId) return;
    try {
      await acp.request('session/close', { sessionId }, 5000);
    } catch { /* 关了就行，失败也不影响本地状态 */ }
  }

  /**
   * 用 session/load 还原重启前的会话。
   *
   * ACP 规定 load 会把历史以 session/update 重放回来；此刻没有真实 handler，但可能有并发
   * 请求挂在同一 sessionId 上，所以临时挂个空 handler 吞掉重放，避免混进正文。
   */
  async function loadSession(sessionId, cwd, mcpServers) {
    const had = handlers.has(sessionId);
    let loadedUsage = null;
    if (!had) {
      handlers.set(sessionId, (u) => {
        if (u && u.sessionUpdate === 'usage_update') loadedUsage = u;
      });
    }
    try {
      await acp.request('session/load', { sessionId, cwd, mcpServers }, 120000);
      return loadedUsage;
    } finally {
      if (!had) handlers.delete(sessionId);
    }
  }

  /**
   * 客户端断开：ACP 的 session/cancel 是「通知」（无 id、不等回复），实测能让本轮以
   * stopReason=cancelled 结束，而且保留进程与会话记忆。旧版直接杀运行时是下策。
   * 只取消该 HTTP 请求拥有的活动 prompt；排队请求只标记取消，不能误伤其它请求。
   */
  function watchDisconnect(res, task) {
    if (typeof res.on !== 'function') return;
    res.on('close', () => {
      if (res.writableEnded) return;
      const cfg = getConfig();
      log('客户端已断开');
      if (cfg.cancelOnDisconnect === false) {
        log('cancelOnDisconnect 已关闭：让 agent 自己跑完');
        return;
      }
      task.cancelled = true;
      if (!task.sessionId || !task.active) {
        if (task.sessionKey) {
          const b = bridges.get(task.sessionKey);
          if (b && Array.isArray(b.parked) && b.parked.length > 0) {
            preemptParkedBridge(task.sessionKey, '客户端中断排队请求，同步释放同会话挂起工具轮次').catch(() => {});
          }
        }
        return;
      }
      acp.notify('session/cancel', { sessionId: task.sessionId });
      log(`已发送 session/cancel 通知（保留运行时与会话 ${String(task.sessionId).slice(0, 8)}…，不再 close/杀进程）`);
      if (task.sessionKey) {
        const h = sessions.get(task.sessionKey);
        if (h) h.interrupted = true;
        const b = bridges.get(task.sessionKey);
        if (b) {
          b.gen = (b.gen || 0) + 1;
          bridgeTurn.clearParked(b, '客户端断开连接（停止）');
          b.running = false;
        }
      }
    });
  }

  acp.onNotification = (msg) => {
    if (msg.method !== 'session/update') return;
    const sessionId = msg.params && msg.params.sessionId;
    const handler = handlers.get(sessionId);
    if (typeof handler === 'function') handler(msg.params.update || {});
  };

  /**
   * 运行时崩溃、被外部杀掉、或面板换过 bin 之后，旧实现只会一直返 502「ACP 运行时未启动」，
   * 直到用户手动重启网关。现在每次请求前确认一次在位情况：不 ready 就重新拉起
   * （AcpRuntime.start() 自身单飞 + 幂等，重复调用不会起两个进程）。
   */
  async function ensureRuntime() {
    if (typeof acp.status !== 'function') {
      await acp.start();
      return;
    }
    let running = false;
    try {
      const snapshot = acp.status();
      running = Boolean(snapshot && (snapshot.running || snapshot.ready));
    } catch { running = false; }
    if (running) {
      // 开机时 VPN/代理软件往往比 PI-Desktop 起得晚：运行时按「直连」起来后就永远连不上网，
      // 表现为模型发现、session/load、prompt 全部 Internal error。这里做单向恢复：
      // 直连 → 有代理 时重建一次；反向不动（免得开关 VPN 反复重启），有轮次在跑也等下一轮。
      const drift = typeof acp.proxyDrift === 'function' ? acp.proxyDrift() : '';
      if (!drift) return;
      if (activePrompts > 0) {
        log(`运行时是按直连启动的，现在检测到代理 ${drift}：等本轮结束后重建运行时`);
        return;
      }
      log(`运行时是按直连启动的，现在检测到代理 ${drift}：重建运行时（否则联网调用都会失败）`);
      try {
        await acp.restart('代理可用性变化');
      } catch { /* ignore */ }
      running = false;
    }
    if (running) return;
    log('运行时不在位：按需重新拉起');
    await acp.start();
  }

  // 空闲回收：用 session/close 把 worker 放掉，但保留映射与足迹，下次发言优先 session/resume。
  const idleSweepTimer = setInterval(() => {
    const now = Date.now();
    const limit = idleSessionMs();
    for (const [key, value] of sessions) {
      if (value.inflight > 0) continue;
      if (value.closed) {
        if (now - value.touched > limit * 6) {
          // 只丢内存映射，**保留足迹**：下次同一对话先试 session/load 接回，
          // 避免重放整段历史（重放会让服务端前缀缓存全灭）。足迹有 1 天 TTL，不会无限堆积。
          sessions.delete(key);
        }
        continue;
      }
      if (now - value.touched >= limit) {
        value.closed = true;
        closeSession(value.sessionId);
        sessionStore.touch(key);
        log(`空闲回收：session/close ${String(value.sessionId).slice(0, 8)}…（下次可 resume）`);
      }
    }
  }, 60000).unref();

  /** 在已有会话上切换模型/档位；失败重试一次，仍失败就抛出（由调用方决定重建）。 */
  async function switchModel(sessionId, modelId) {
    const attempt = () => acp.request('session/set_model', { sessionId, modelId }, 30000);
    try {
      await attempt();
    } catch (first) {
      log(`set_model 失败，重试一次：${String(first.message).slice(0, 160)}`);
      await acp.start();
      await attempt();
    }
  }

  /**
   * 把会话切到本轮要的模型；切不过去就丢掉映射与足迹返回 false（调用方重建）。
   * 为什么不直接重建：重建要把整段历史重放一遍，服务端前缀缓存全灭——能用 set_model 就别重建。
   */
  async function applyModel(key, hit, model) {
    if (!model || hit.model === model) return true;
    try {
      await switchModel(hit.sessionId, model);
      hit.model = model;
      log(`会话 ${String(hit.sessionId).slice(0, 8)}… 模型切到 ${model}（复用会话，不重放历史）`);
      return true;
    } catch (error) {
      log(`模型切换失败：${String(error.message).slice(0, 120)}；重建会话`);
      await closeSession(hit.sessionId);
      sessions.delete(key);
      sessionStore.remove(key);
      return false;
    }
  }

  async function sessionFor(model, messages, req = {}, mcpServers = []) {
    const cfg = getConfig();
    const key = keyFor(messages, req);
    await ensureRuntime();
    const cwd = await acp.cwdFor();
    const wantBridge = Array.isArray(mcpServers) && mcpServers[0] ? String(mcpServers[0].url || '') : '';
    let hit = sessions.get(key);
    const currentUsers = extractUserPrompts(messages);
    // 内存映射可能已被丢弃（超时放弃、空闲淘汰），但足迹还在：先试 session/load 接回来。
    // 命中就不用重放整段历史——这也是保住服务端前缀缓存的前提。
    if (!hit) {
      const rec = sessionStore.get(key);
      if (rec && rec.sessionId) {
        hit = {
          sessionId: rec.sessionId, model: rec.model, bridgeUrl: rec.bridgeUrl,
          touched: rec.touched, closed: true, inflight: 0, restored: true,
          userHistory: Array.isArray(rec.userHistory) ? rec.userHistory : [],
          ...(rec.contextUsed > 0 ? { contextUsed: rec.contextUsed } : {}),
          ...(rec.contextSize > 0 ? { contextSize: rec.contextSize } : {}),
        };
        sessions.set(key, hit);
        log(`会话映射已丢弃但足迹仍在：尝试 session/load ${String(rec.sessionId).slice(0, 8)}…`);
      }
    }
    // 检测是否为「停止后修改重新对话 / 分支切换 / 历史截断回滚」：
    // 若当前请求的 user 提问轮数少于或等于旧历史，或历史中的任一条提问被改动，说明用户发起了新的分支生成。
    // 底层运行时（ACP）没有回滚或覆盖接口；若继续当成 resume 增量，修改内容将进不去且残留旧版本冲突。
    // 因此检测到分支修改时，必须优雅重置会话，以修改后的完整上下文重新生成。
    let isBranchRevision = false;
    const hasAssistant = Array.isArray(messages) && messages.some((m) => m && m.role === 'assistant');
    if (hit && Array.isArray(hit.userHistory) && hit.userHistory.length > 0) {
      if (hit.interrupted) {
        // 上一轮被用户点击「停止」（中断）：无论 inflight 状态如何，只要提问内容被修改，判定为分支重发
        const lastOld = hit.userHistory[hit.userHistory.length - 1];
        const lastNew = currentUsers[currentUsers.length - 1];
        if (lastNew && lastOld && lastNew !== lastOld) {
          isBranchRevision = true;
        }
      } else if (!hit.inflight || hit.inflight === 0) {
        if (hasAssistant) {
          if (currentUsers.length <= hit.userHistory.length) {
            for (let i = 0; i < currentUsers.length; i += 1) {
              if (currentUsers[i] !== hit.userHistory[i]) {
                isBranchRevision = true;
                break;
              }
            }
          } else {
            for (let i = 0; i < hit.userHistory.length; i += 1) {
              if (hit.userHistory[i] !== currentUsers[i]) {
                isBranchRevision = true;
                break;
              }
            }
          }
        }
      }
    }
    if (isBranchRevision && hit) {
      log(`会话 ${String(hit.sessionId).slice(0, 8)}… 检测到用户修改提问或切换历史版本（当前 ${currentUsers.length} 轮，原 ${hit.userHistory.length} 轮），重置会话并以完整修改后内容全新生成`);
      const oldSid = hit.sessionId;
      await closeSession(oldSid);
      sessions.delete(key);
      sessionStore.remove(key);
      const b = bridges.get(key);
      if (b) {
        bridgeTurn.clearParked(b, '用户修改历史或重新对话');
        b.running = false;
        b.sessionId = null;
      }
      hit = null;
    }
    // 1) 网关或运行时重启后留下的足迹：session/load 能把历史一起接回来（会话本体在运行时那边）。
    //    必须排在「工具桥不匹配就重建」之前——重启后 MCP 端口会变，而 load 本身就能重新挂载。
    if (hit && hit.restored) {
      try {
        const loadedUsage = await loadSession(hit.sessionId, cwd, mcpServers);
        if (loadedUsage) {
          if (Number.isFinite(loadedUsage.used) && loadedUsage.used > 0) hit.contextUsed = loadedUsage.used;
          if (Number.isFinite(loadedUsage.size) && loadedUsage.size > 0) hit.contextSize = loadedUsage.size;
        }
        hit.restored = false;
        hit.closed = false;
        hit.bridgeUrl = wantBridge;
        hit.touched = Date.now();
        sessionStore.touch(key);
        log(`已用 session/load 还原会话 ${String(hit.sessionId).slice(0, 8)}…（历史留在运行时那边，不再重放）`);
        // 还原出来的会话带着上次的模型；本轮换档位必须显式 set_model，否则等于静默忽略用户的选择。
        if (!(await applyModel(key, hit, model))) hit = null;
        if (hit) {
          hit.userHistory = currentUsers;
          sessionStore.set(key, { sessionId: hit.sessionId, model: hit.model, bridgeUrl: hit.bridgeUrl, touched: hit.touched, contextUsed: hit.contextUsed, contextSize: hit.contextSize, userHistory: currentUsers });
          return { sessionId: hit.sessionId, resume: true, key };
        }
      } catch (error) {
        log(`session/load 失败：${String(error.message).slice(0, 120)}；改为新建会话`);
        sessions.delete(key);
        sessionStore.remove(key);
        hit = null;
      }
    }
    // 桥接地址变了（开关桥接、或内部桥接端口变了）：先关 worker 再 session/load 重新挂载。
    // 实测 close 之后 load/resume 历史仍在，所以这条路比重建（整段重放）便宜得多。
    if (hit && wantBridge && hit.bridgeUrl !== wantBridge) {
      log(`会话 ${String(hit.sessionId).slice(0, 8)}… 的桥接地址变了：关 worker 后 session/load 重新挂载`);
      await closeSession(hit.sessionId);
      try {
        const loadedUsage = await loadSession(hit.sessionId, cwd, mcpServers);
        if (loadedUsage) {
          if (Number.isFinite(loadedUsage.used) && loadedUsage.used > 0) hit.contextUsed = loadedUsage.used;
          if (Number.isFinite(loadedUsage.size) && loadedUsage.size > 0) hit.contextSize = loadedUsage.size;
        }
        hit.closed = false;
        hit.bridgeUrl = wantBridge;
        hit.touched = Date.now();
        log(`已重新挂载工具桥并接回会话 ${String(hit.sessionId).slice(0, 8)}…（不重放历史）`);
        if (!(await applyModel(key, hit, model))) hit = null;
        if (hit) {
          hit.userHistory = currentUsers;
          sessionStore.set(key, { sessionId: hit.sessionId, model: hit.model, bridgeUrl: wantBridge, touched: hit.touched, contextUsed: hit.contextUsed, contextSize: hit.contextSize, userHistory: currentUsers });
          return { sessionId: hit.sessionId, resume: true, key };
        }
      } catch (error) {
        log(`重新挂载失败：${String(error.message).slice(0, 120)}；改为重建会话`);
        sessions.delete(key);
        sessionStore.remove(key);
        hit = null;
      }
    }
    if (hit && sessions.has(key)) {
      hit.touched = Date.now();
      // 同一对话换了思考档位：档位不进会话键，所以这里必须把会话切到新档位，
      // 否则会拿旧档位回答（等于静默忽略用户选择的档位）。切换失败就重建，绝不冒充。
      if (!hit.closed && model && hit.model !== model) {
        try {
          await switchModel(hit.sessionId, model);
          log(`会话 ${String(hit.sessionId).slice(0, 8)}… 模型切到 ${model}（复用会话，不重放历史）`);
          hit.model = model;
          sessionStore.set(key, { sessionId: hit.sessionId, model, bridgeUrl: hit.bridgeUrl, touched: hit.touched });
        } catch (error) {
          log(`模型切换失败：${String(error.message).slice(0, 120)}；重建会话`);
          await closeSession(hit.sessionId);
          sessions.delete(key);
          sessionStore.remove(key);
          hit.closed = true;
        }
      }
      if (sessions.has(key) && !hit.closed) {
        hit.userHistory = currentUsers;
        sessionStore.touch(key);
        return { sessionId: hit.sessionId, resume: true, key };
      }
      if (!sessions.has(key)) {
        // 上面切换失败已经删掉了映射，走新建流程
      } else {
        try {
          await acp.request('session/resume', { sessionId: hit.sessionId, cwd, mcpServers }, 45000);
          hit.closed = false;
          hit.bridgeUrl = wantBridge;
          if (model && hit.model !== model) {
            await switchModel(hit.sessionId, model);
            hit.model = model;
          }
          hit.userHistory = currentUsers;
          sessionStore.set(key, { sessionId: hit.sessionId, model: hit.model, bridgeUrl: wantBridge, touched: Date.now(), userHistory: currentUsers });
          log(`已 resume 会话 ${String(hit.sessionId).slice(0, 8)}…（不重放历史）`);
          return { sessionId: hit.sessionId, resume: true, key };
        } catch (error) {
          log(`session/resume 失败：${String(error.message).slice(0, 120)}；改为新建会话`);
          await closeSession(hit.sessionId);
          sessions.delete(key);
          sessionStore.remove(key);
        }
      }
    }
    const created = await acp.request('session/new', { cwd, mcpServers }, 60000);
    if (model && created.models && created.models.currentModelId !== model) {
      try {
        await switchModel(created.sessionId, model);
      } catch (error) {
        // 关键：切换失败时绝不拿会话默认模型冒充用户选的模型
        await closeSession(created.sessionId);
        throw Object.assign(
          new Error(`无法切换到模型 ${model}（${String(error.message).slice(0, 120)}）；已拒绝改用其它模型回答`),
          { code: 'MODEL_SWITCH_FAILED' },
        );
      }
    }
    sessions.set(key, { sessionId: created.sessionId, model, touched: Date.now(), closed: false, inflight: 0, bridgeUrl: wantBridge, userHistory: currentUsers });
    sessionStore.set(key, { sessionId: created.sessionId, model, bridgeUrl: wantBridge, userHistory: currentUsers });
    if (sessions.size > cfg.maxSessions) {
      const idle = [...sessions.entries()]
        .filter(([k, v]) => k !== key && !v.closed && v.inflight === 0)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (idle) {
        idle[1].closed = true;
        closeSession(idle[1].sessionId);
        sessionStore.touch(idle[0]);
        log(`会话数超过上限 ${cfg.maxSessions}：已 session/close 最久未用的会话`);
      } else {
        const stale = [...sessions.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (stale) {
          // 只丢内存映射，保留足迹：历史还能靠 session/load 接回，不必重放
          sessions.delete(stale[0]);
          log('会话数超过上限且其它会话都在忙：丢弃最久未用的本地记录');
        }
      }
    }
    return { sessionId: created.sessionId, resume: false, key };
  }

  /** 一次 prompt：受并发限制器控制，按 sessionId 路由通知。 */
  async function prompt(sessionId, text, onUpdate, imageUrls = [], docs = [], stats = { toolCounts: new Map() }, policy = '') {
    const cfg = getConfig();
    const startedAt = Date.now();
    // 附件必须落在会话工作区里：运行时的 view_file 只允许读 workspace 内的路径，
    // 放到系统 temp 会被拒绝（实测会浪费三分钟反复重试）。
    const cwd = await acp.cwdFor();
    const attachDir = attachmentsPath || path.join(cwd, '.attachments');
    const allowedRoots = [cwd, attachDir, os.tmpdir()];
    const blocks = await buildPromptBlocks(text, imageUrls, docs, attachDir, allowedRoots);
    if (imageUrls.length > 0 || docs.length > 0) {
      const images = blocks.filter((b) => b.type === 'image');
      const links = blocks.filter((b) => b.type === 'resource_link');
      const parts = [];
      if (imageUrls.length > 0) parts.push(`图片 ${images.length}/${imageUrls.length}`);
      if (docs.length > 0) parts.push(`文档 ${links.length}/${docs.length}（${links.map((b) => b.mimeType).join(', ') || '全部读取失败'}）`);
      log(`prompt 携带 ${parts.join('，')}`);
    }
    // 运行时同一连接上并发 `receive_steps()` 会直接报
    // `Concurrent receive_steps() calls are not supported on this connection`（宿主上一轮未收尾又发一轮就会撞上）。
    // 所以这里把 prompt 串行化：后来的排队，不再并行打到同一连接。
    const isBusy = (busySessions.has(sessionId) && sessionPromptChains.has(String(sessionId))) ||
      (limiter && typeof limiter.stats === 'function' && limiter.stats().active > 0);
    if (isBusy) {
      log(`同一会话上一轮未结束或并发已达上限，本轮在网关层排队等待（会话 ${String(sessionId).slice(0, 8)}…）`);
    }
    try {
      return await limiter.run(() => serializeSessionPrompt(sessionId, async () => {
      if (stats.task?.cancelled) throw Object.assign(new Error('Client disconnected before prompt started'), { code: 'PROMPT_CANCELLED' });
      if (stats.task) { stats.task.sessionId = sessionId; stats.task.active = true; }
      activePrompts += 1;
      if (policy) acp.policyBySession.set(sessionId, policy);
      const ownerEntry = [...sessions.entries()].find(([, v]) => v.sessionId === sessionId);
      const ownerKey = ownerEntry ? ownerEntry[0] : '';
      const owner = ownerEntry ? ownerEntry[1] : null;
      if (owner) {
        owner.inflight += 1;
        if (Number.isFinite(owner.contextUsed)) stats.contextUsed = owner.contextUsed;
        if (Number.isFinite(owner.contextSize)) stats.contextSize = owner.contextSize;
      }
      let lastBeat = Date.now();
      stats.roundText = 0;
      stats.roundTools = 0;
      const wrapped = (u) => {
        lastBeat = Date.now();
        if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) stats.roundText += u.content.text.length;
        trackBackgroundTool(stats, u);
        if (u && u.sessionUpdate === 'tool_call') {
          const kind = String(u.kind || 'other');
          stats.roundTools += 1;
          stats.toolCounts.set(kind, (stats.toolCounts.get(kind) || 0) + 1);
          if (!Array.isArray(stats.toolLog)) stats.toolLog = [];
          if (stats.toolLog.length < 40) stats.toolLog.push(String(u.title || kind).replace(/\s+/g, ' ').slice(0, 70));
        }
        if (u && u.sessionUpdate === 'usage_update') {
          if (Number.isFinite(u.used)) { stats.contextUsed = u.used; if (owner) owner.contextUsed = u.used; }
          if (Number.isFinite(u.size)) { stats.contextSize = u.size; if (owner) owner.contextSize = u.size; }
        }
        if (typeof onUpdate === 'function') onUpdate(u);
      };
      if (typeof onUpdate === 'function') handlers.set(sessionId, wrapped);

      // 活动看门狗：判据是「多久完全没有进展」，而不是「整轮最多 N 分钟」。
      // session/cancel 只是通知，运行时不一定回复；所以取消后再给一段宽限，
      // 仍无结果就放弃这次 RPC，避免把串行锁一直挂到硬超时。
      const idleMs = Math.max(2000, Number(stats.idleOverrideMs) || Number(cfg.promptIdleTimeoutMs) || 240000);
      const bgNoteMs = Math.max(1000, Math.min(25000, Math.round(idleMs / 3)));
      const bgCapMs = 30 * 60000;
      const graceMs = 20000;
      let stalled = false;
      let cancelAt = 0;
      let heartbeats = 0;
      let lastHeartbeatAt = 0;
      const watch = setInterval(() => {
        // 后台子任务在跑：不发取消，改成周期性进度并顺延，避免把合法长任务砍掉
        if (stats.bg && stats.bg.size > 0) {
          if (!stats.bgSince) stats.bgSince = Date.now();
          if (Date.now() - stats.bgSince > bgCapMs) {
            log(`后台子任务超过 ${Math.round(bgCapMs / 60000)} 分钟仍无终态：发送 session/cancel`);
            try { acp.notify('session/cancel', { sessionId }); } catch { /* ignore */ }
            stalled = true; cancelAt = Date.now(); stats.bg.clear();
            return;
          }
          if (Date.now() - lastBeat >= bgNoteMs) {
            lastBeat = Date.now();
            const note = `· 后台子任务仍在运行（${stats.bg.size} 个），等待结果…\n`;
            log(note.trim());
          }
          return;
        }
        // 桥接挂起：运行时正等宿主执行工具，这段时间按设计一个事件都不会有，不能当成卡死。
        // （以前这里会把 180 秒的等待判成卡死，取消掉正在跑工具的那一轮，用户看到的就是「卡 3 分钟然后重置」。）
        if (typeof stats.parked === 'function' && stats.parked()) {
          if (Date.now() - lastBeat >= bgNoteMs) {
            lastBeat = Date.now();
            const note = `· 等待宿主执行工具${stats.parkedName ? ` ${stats.parkedName}` : ''}…\n`;
            log(note.trim());
          }
          return;
        }
        // 无进展判定优先：到点就取消，心跳不能占用这次机会（否则一直发心跳、永不判定）。
        if (Date.now() - lastBeat < idleMs) {
          // 还没到阈值：给可见的等待提示，避免长时间静默被误认为卡死或触发客户端超时。
          // 8 秒首发一次，后续每隔 15 秒更新一次；严格检查 lastHeartbeatAt，杜绝短间隔连续刷屏。
          if (!stalled && (stats.roundText || 0) === 0) {
            const waitedMs = Date.now() - lastBeat;
            const shouldBeat = (heartbeats === 0 && waitedMs >= 8000) ||
                               (heartbeats > 0 && Date.now() - lastHeartbeatAt >= 15000);
            if (shouldBeat && heartbeats < 8) {
              heartbeats += 1;
              lastHeartbeatAt = Date.now();
              const waited = Math.round(waitedMs / 1000);
              const note = `· 正在等待模型首个响应（已 ${waited} 秒，上游排队或深度思考中）…\n`;
              log(note.trim());
            }
          }
          return;
        }
        if (!stalled) {
          stalled = true;
          cancelAt = Date.now();
          log(`本轮 ${Math.round(idleMs / 1000)} 秒无任何进展：发送 session/cancel，宽限 ${Math.round(graceMs / 1000)} 秒等待收尾`);
          try { acp.notify('session/cancel', { sessionId }); } catch { /* ignore */ }
          return;
        }
        if (Date.now() - cancelAt < graceMs) return;
        clearInterval(watch);
        log('取消后仍无任何回复：放弃这一轮的等待，并丢弃该会话');
        if (typeof acp.abandon === 'function') acp.abandon('session/prompt', '本轮长时间无进展，已放弃等待', sessionId);
      }, 2000);
      watch.unref?.();
      try {
        let result;
        try {
          result = await acp.request('session/prompt', { sessionId, prompt: blocks }, cfg.promptTimeoutMs);
        } catch (error) {
          // 硬上限只是兜底：真撞上时先让运行时停下这一轮，否则下一轮会撞 receive_steps 并发错误
          if (error && error.code === 'ACP_TIMEOUT') {
            log('本轮撞到硬上限：先 session/cancel，再结束这一轮');
            try { acp.notify('session/cancel', { sessionId }); } catch { /* ignore */ }
          }
          const isSteerOrPreempt = error && error.message && (
            error.message.includes('轮中') ||
            error.message.includes('改变方向') ||
            error.message.includes('中断') ||
            error.message.includes('释放挂起') ||
            error.message.includes('steer')
          );
          if (error && !isSteerOrPreempt && (error.code === 'ACP_TIMEOUT' || error.code === 'ACP_ABANDONED')) {
            // 这一轮的 RPC 已经没人等了，运行时却可能还在跑：同会话再发会撞并发。
            // 关掉 worker 并同时丢掉内存映射与持久化足迹，避免下一轮又把坏会话 load 回来。
            const key = [...sessions.entries()].find(([, v]) => v.sessionId === sessionId)?.[0];
            if (key) {
              sessions.delete(key);
              sessionStore.remove(key);
              const b = bridges.get(key);
              if (b) bridgeTurn.clearParked(b, '会话因无进展已重建');
              bridges.delete(key);
            }
            try { await acp.request('session/close', { sessionId }, 5000); } catch { /* ignore */ }
            log('已关闭不可用的会话并清除足迹，下一轮将重建');
          }
          throw error;
        }
        stats.lastRoundText = stats.roundText || 0;
        stats.lastRoundTools = stats.roundTools || 0;
        return result;
      } finally {
        clearInterval(watch);
        activePrompts -= 1;
        if (stats.task) stats.task.active = false;
        handlers.delete(sessionId);
        if (owner) {
          owner.inflight = Math.max(0, owner.inflight - 1);
          if (ownerKey && (owner.contextUsed > 0 || owner.contextSize > 0)) {
            sessionStore.set(ownerKey, {
              sessionId: owner.sessionId, model: owner.model, bridgeUrl: owner.bridgeUrl,
              touched: owner.touched, contextUsed: owner.contextUsed, contextSize: owner.contextSize,
            });
          }
        }
        if (stats.toolCounts.size > 0) log(`本次工具使用：${[...stats.toolCounts.entries()].map(([k, v]) => `${k}×${v}`).join('，')}`);
        if (stats.contextUsed) log(`上下文占用 ${stats.contextUsed}/${stats.contextSize} token`);
        if (policy) acp.policyBySession.delete(sessionId);
        lastRequest = {
          at: new Date().toISOString(),
          session: String(sessionId).slice(0, 8),
          model: owner && owner.model ? owner.model : '',
          policy: policy || cfg.toolPolicy,
          ms: Date.now() - startedAt,
          contextUsed: stats.contextUsed || 0,
          contextSize: stats.contextSize || 0,
          tools: Object.fromEntries(stats.toolCounts),
        };
        appendUsage(cfg, lastRequest);
      }
    }));
    } finally {
    }
  }
  // Never infer a runtime limit from tool activity or replay side effects in a fresh session.
  async function promptAll(sessionId, text, onUpdate, imageUrls, docs, stats, policy) {
    let result = await prompt(sessionId, text, onUpdate, imageUrls, docs, stats, policy);
    let chars = stats.lastRoundText || 0;
    log(`本轮结果：正文 ${chars} 字 · 工具 ${stats.lastRoundTools || 0} 次 · stopReason=${result?.stopReason || '(missing)'}`);
    if (result?.stopReason === 'cancelled') throw Object.assign(new Error('本轮被取消'), { code: 'PROMPT_CANCELLED' });

    // 同一会话催答：上下文与工具结果都还在，不会重复副作用。
    // 旧版换新会话、只带工具标题重放，会丢上下文并可能重复写文件，已删除。
    for (let nudge = 1; nudge <= 2 && chars === 0; nudge += 1) {
      // 催答轮如果没反应，不值得再等满整轮静默上限
      stats.idleOverrideMs = 90000;
      log(`本轮没有正文，同一会话催第 ${nudge} 次（不重放、不换会话）`);
      result = await prompt(sessionId, NUDGE_TEXT, onUpdate, [], [], stats, policy);
      chars = stats.lastRoundText || 0;
      log(`催第 ${nudge} 次结果：正文 ${chars} 字 · 工具 ${stats.lastRoundTools || 0} 次 · stopReason=${result?.stopReason || '(missing)'}`);
      if (result?.stopReason === 'cancelled') break;
    }
    stats.lastRoundText = chars;
    if (!chars) throw Object.assign(new Error('运行时的这一轮没有产出正文（会话已保留，未自动重放工具）'), { code: 'EMPTY_RESPONSE' });
    return result;
  }
  /**
   * 桥接一轮：运行时调工具 → 挂起 → 发 tool_calls → 宿主执行 → 结果回来 → 回填 → 继续。
   * 工具始终由宿主执行（原生卡片、权限、hooks），网关不执行任何工具。
   */
  function seedSessionStats(key, s) {
    if (!key || !s) return;
    const hit = sessions.get(key) || sessionStore.get(key);
    if (!hit) return;
    if (Number.isFinite(hit.contextUsed) && hit.contextUsed > 0) s.contextUsed = hit.contextUsed;
    if (Number.isFinite(hit.contextSize) && hit.contextSize > 0) s.contextSize = hit.contextSize;
  }

  async function waitPromptIdle(targetSid, reason = '释放挂起轮次', graceMs = 1500) {
    if (!targetSid) return;
    const hit = [...sessions.values()].find((v) => v.sessionId === targetSid);
    const isStillRunning = () => busySessions.has(targetSid) && (!hit || hit.inflight > 0);
    const deadline = Date.now() + graceMs;
    while (isStillRunning() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (isStillRunning()) {
      log(`桥接：取消轮次超时未释放串行锁，强制放弃 session/prompt（会话 ${String(targetSid).slice(0, 8)}…）`);
      try { if (typeof acp.abandon === 'function') acp.abandon('session/prompt', reason, targetSid); } catch { /* ignore */ }
      const abandonDeadline = Date.now() + 200;
      while (busySessions.has(targetSid) && Date.now() < abandonDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  async function preemptParkedBridge(key, reason = '宿主发起无工具请求，中断挂起工具调用') {
    const bridge = key ? bridges.get(key) : null;
    if (!bridge) return false;
    const hasParked = Array.isArray(bridge.parked) && bridge.parked.length > 0;
    const hit = sessions.get(key);
    const hasPausedPrompt = !bridge.waiting && Boolean((hit && hit.inflight > 0) || (bridge.sessionId && busySessions.has(bridge.sessionId)));
    if (!hasParked && !hasPausedPrompt) return false;
    const targetSid = bridge.sessionId || (hit && hit.sessionId) || '';
    log(`桥接：${reason}（会话 ${String(targetSid || key).slice(0, 8)}…，挂起工具 ${hasParked ? bridge.parked.length : 0} 个）`);
    bridge.gen = (bridge.gen || 0) + 1;
    bridgeTurn.clearParked(bridge, reason);
    if (targetSid) {
      try { acp.notify('session/cancel', { sessionId: targetSid }); } catch { /* ignore */ }
      await waitPromptIdle(targetSid, reason);
    }
    return true;
  }

  function isSummarizeRequest(messages, req = {}) {
    const hasTools = Array.isArray(req && req.tools) && req.tools.length > 0;
    if (hasTools) return false;
    const checkText = (str) => {
      if (typeof str !== 'string' || !str) return false;
      return str.includes('context summarization assistant') ||
        str.includes('context checkpoint summary') ||
        str.includes('conversation to summarize') ||
        str.includes('Summarize the prefix to provide context') ||
        str.includes('ONLY output the structured summary') ||
        str.includes('Summarize the entire conversation');
    };
    if (checkText(req.instructions) || checkText(req.system)) return true;
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m) continue;
      const content = m.content;
      if (typeof content === 'string') {
        if (checkText(content)) return true;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && checkText(part.text)) return true;
        }
      }
    }
    return false;
  }

  function isSideChannelRequest(key, messages, req, cfg) {
    if (cfg.bridgeTools === false) return false;
    const hasTools = Array.isArray(req && req.tools) && req.tools.length > 0;
    if (hasTools) return false;
    // 上下文压缩总结请求：即使带了 previous_response_id 或包含完整多轮历史，也必须识别为旁路独立会话
    if (isSummarizeRequest(messages, req)) return true;
    if (req && req.previous_response_id) return false;
    const b = bridges.get(key);
    const mem = sessions.get(key);
    const stored = sessionStore.get(key);
    const bridgedConv = Boolean(
      (b && (b.sessionId || (b.tools && b.tools.length > 0) || (b.parked && b.parked.length > 0))) ||
      (mem && mem.bridgeUrl) ||
      (stored && stored.bridgeUrl),
    );
    if (!bridgedConv) return false;
    if (b && Array.isArray(b.parked) && b.parked.length > 0) return true;
    const nonSystem = messages.filter((m) => m && m.role !== 'system');
    return nonSystem.length === 1 && nonSystem[0].role === 'user';
  }

  async function prepareNonBridgedSession(concreteModel, messages, req, cfg) {
    const key = keyFor(messages, req);
    const sideChannel = isSideChannelRequest(key, messages, req, cfg);
    if (cfg.bridgeTools !== false) {
      await preemptParkedBridge(key, '宿主发起无工具请求，释放同会话挂起工具轮次');
    }
    if (sideChannel) {
      await ensureRuntime();
      const cwd = await acp.cwdFor();
      const created = await acp.request('session/new', { cwd, mcpServers: [] }, 60000);
      if (concreteModel && created.models && created.models.currentModelId !== concreteModel) {
        try {
          await switchModel(created.sessionId, concreteModel);
        } catch (error) {
          await closeSession(created.sessionId);
          throw Object.assign(
            new Error(`无法切换到模型 ${concreteModel}（${String(error.message).slice(0, 120)}）；已拒绝改用其它模型回答`),
            { code: 'MODEL_SWITCH_FAILED' },
          );
        }
      }
      log(`旁路无工具请求（如上下文压缩）：使用独立临时会话 ${String(created.sessionId).slice(0, 8)}…（不污染原会话）`);
      return {
        sessionId: created.sessionId,
        resume: false,
        key,
        ephemeral: true,
        policyOverride: 'none',
        cleanup: () => closeSession(created.sessionId),
      };
    }
    const prepared = await sessionFor(concreteModel, messages, req);
    return { ...prepared, ephemeral: false, policyOverride: '', cleanup: null };
  }

  const bridgeTurn = createBridgeTurn({
    bridges, ensureBridgeServer, ensureRuntime, sessionFor, prompt, policyForRequest,
    usageFor, log, acp, projectTools, flatten, getConfig, lastUserImages, lastUserDocs,
    seedSessionStats, waitPromptIdle, isSessionBusy: (sid) => busySessions.has(sid),
  });

  /** Chat Completions 适配层：只决定“怎么说”，状态机在 lib/bridge-turn.js。 */
  async function chatBridged(res, req, messages, stats, cfg, model, effort) {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const sse = openSse(res, {
      onAbort: ({ elapsed, frames }) => log(`桥接流中断 ${id.slice(-8)}：历时 ${elapsed} ms · 已发 ${frames} 帧`),
    });
    const send = (delta, finish = null, usage = null) => {
      const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) chunk.usage = usage;
      sse.data(chunk);
    };
    const adapter = {
      begin: () => send({ role: 'assistant' }),
      text: (piece, usage) => send({ content: piece }, null, usage),
      thought: (piece) => send({ reasoning_content: piece }),
      park: (call, usage, text = '') => {
        if (text) send({ content: text });
        send({ tool_calls: toToolCalls(call) }, 'tool_calls', usage);
      },
      finish: (usage) => send({}, 'stop', usage),
      error: (error, partial) => {
        if (partial) send({}, 'length', usageFor('', partial, '', stats));
        else sse.data({ error: { message: `Antigravity 调用失败：${String(error.message).slice(0, 300)}`, type: 'antigravity_acp', code: error.code || 'prompt_failed' } });
      },
      end: () => { sse.done(); sse.end(); },
    };
    return bridgeTurn.run({
      key: keyFor(messages, req), req, messages, stats, cfg, model, effort, adapter,
      matchToolResult, toolResultText,
    });
  }

  /** Responses 适配层：同一个状态机，事件换成 response.*。 */
  async function responsesBridged(res, req, messages, stats, cfg, model, effort) {
    const id = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    let rsId = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
    const sse = openSse(res, {
      onAbort: ({ elapsed, frames }) => log(`桥接流中断 ${id.slice(-8)}：历时 ${elapsed} ms · 已发 ${frames} 帧`),
    });
    const emit = (type, payload) => sse.event(type, payload);
    let roundItems = [];
    let messageIndex = -1;
    let reasoningIndex = -1;
    let roundThought = '';
    const envelope = (status, output, usage) => {
      const out = { id, object: 'response', created_at: createdAt, status, model };
      if (output) out.output = output;
      if (usage) {
        out.usage = {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          estimated: usage.estimated !== false,
          ...(usage.context_used !== undefined ? { context_used: usage.context_used } : {}),
          ...(usage.context_size !== undefined ? { context_size: usage.context_size } : {}),
        };
      }
      return out;
    };
    const openMessage = () => {
      if (messageIndex >= 0) return messageIndex;
      messageIndex = roundItems.length;
      roundItems.push(null);
      emit('response.output_item.added', { output_index: messageIndex, item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: msgId, output_index: messageIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      return messageIndex;
    };
    const closeMessage = (text) => {
      const mIdx = openMessage();
      messageIndex = -1;
      emit('response.output_text.done', { item_id: msgId, output_index: mIdx, content_index: 0, text });
      emit('response.content_part.done', { item_id: msgId, output_index: mIdx, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      const msgItem = { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
      emit('response.output_item.done', { output_index: mIdx, item: msgItem });
      roundItems[mIdx] = msgItem;
      msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    };
    const openReasoning = () => {
      if (reasoningIndex >= 0) return reasoningIndex;
      reasoningIndex = roundItems.length;
      roundItems.push(null);
      emit('response.output_item.added', { output_index: reasoningIndex, item: { type: 'reasoning', id: rsId, summary: [] } });
      emit('response.reasoning_summary_part.added', { item_id: rsId, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
      return reasoningIndex;
    };
    const closeReasoning = () => {
      if (reasoningIndex < 0) return;
      const rIdx = reasoningIndex;
      reasoningIndex = -1;
      const rsItem = { type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: roundThought }] };
      emit('response.reasoning_summary_part.done', { item_id: rsId, output_index: rIdx, summary_index: 0, part: { type: 'summary_text', text: roundThought } });
      emit('response.output_item.done', { output_index: rIdx, item: rsItem });
      roundItems[rIdx] = rsItem;
      roundThought = '';
      rsId = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
    };
    const adapter = {
      begin: () => {
        roundItems = [];
        messageIndex = -1;
        reasoningIndex = -1;
        roundThought = '';
        msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
        rsId = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
        emit('response.created', { response: envelope('in_progress', null, null) });
        emit('response.in_progress', { response: envelope('in_progress', null, null) });
      },
      text: (piece, usage) => {
        const mIdx = openMessage();
        emit('response.output_text.delta', { item_id: msgId, output_index: mIdx, content_index: 0, delta: piece });
        void usage;
      },
      thought: (piece) => {
        if (!piece) return;
        roundThought += piece;
        const rIdx = openReasoning();
        emit('response.reasoning_summary_text.delta', { item_id: rsId, output_index: rIdx, summary_index: 0, delta: piece });
      },
      park: (calls, usage, text = '') => {
        const list = Array.isArray(calls) ? calls : (calls ? [calls] : []);
        closeReasoning();
        if (text || messageIndex >= 0) closeMessage(text);
        for (const call of list) {
          const outIndex = roundItems.length;
          const fcId = `fc_${crypto.randomUUID().replace(/-/g, '')}`;
          const item = { type: 'function_call', id: fcId, call_id: call.toolCallId, name: call.name, arguments: JSON.stringify(call.args || {}) };
          emit('response.output_item.added', { output_index: outIndex, item: { ...item, arguments: '' } });
          emit('response.function_call_arguments.delta', { item_id: fcId, output_index: outIndex, delta: item.arguments });
          emit('response.function_call_arguments.done', { item_id: fcId, output_index: outIndex, arguments: item.arguments });
          emit('response.output_item.done', { output_index: outIndex, item });
          roundItems.push(item);
        }
        emit('response.completed', { response: envelope('completed', roundItems, usage) });
      },
      finish: (usage, text = '') => {
        closeReasoning();
        closeMessage(text);
        emit('response.completed', { response: envelope('completed', roundItems, usage) });
      },
      error: (error) => {
        emit('response.failed', { response: { id, object: 'response', created_at: createdAt, status: 'failed', model, error: { code: error.code || 'prompt_failed', message: String(error.message).slice(0, 300) } } });
      },
      end: () => { sse.end(); },
    };
    return bridgeTurn.run({
      key: keyFor(messages, req), req, messages, stats, cfg, model, effort, adapter,
      matchToolResult, toolResultText,
    });
  }

  async function listModels(res) {
    await ensureRuntime();
    const data = await acp.modelsForApi();
    json(res, 200, { object: 'list', data });
  }

  async function chat(res, body, httpReq = {}) {
    let req;
    try { req = JSON.parse(body || '{}'); } catch { return oaiError(res, 400, '请求体不是合法 JSON', 'invalid_json'); }
    const cfg = getConfig();
    const messages = normalizeMessages(req);
    logRequestIds(httpReq, req, 'chat');
    if (!messages.some((m) => m.role === 'user')) return oaiError(res, 400, 'messages 不能为空', 'invalid_request');
    const model = String(req.model || cfg.defaultModel);
    const effort = req.reasoning_effort || (req.reasoning && req.reasoning.effort) || (req.thinking && req.thinking.effort) || req.thinking_effort || cfg.defaultEffort || undefined;
    const stream = req.stream === true;
    const reqKey = keyFor(messages, req);
    const stats = { toolCounts: new Map(), estimateContext: countTokens(flatten(messages)) };
    seedSessionStats(reqKey, stats);
    const task = { sessionId: null, sessionKey: reqKey, cancelled: false, active: false };
    stats.task = task;
    watchDisconnect(res, task);

    // 冷启动（起运行时 / session/new / set_model）实测要 10–20 秒。旧版把 writeHead 放在预热之后，
    // 这段时间客户端连响应头都拿不到（实测 headers 10.4 s），稍严的客户端直接判超时断流。
    // 现在：先把头和首帧发出去，再用 10 秒一次的心跳把长工具链撑住。
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let text = '';
    let thought = '';

    if (!stream) {
      await ensureRuntime();
      await acp.discover();
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await prepareNonBridgedSession(concreteModel, messages, req, cfg);
      task.sessionId = prepared.sessionId;
      const firstText = prepared.resume ? lastUserText(messages) : flatten(messages);
      log(`chat ${model} → ${concreteModel}（effort=${effort || '默认'}，${prepared.ephemeral ? '临时会话' : (prepared.resume ? '续会话' : '新会话')}）${ignoredFor(req)}`);
      const pickedPolicy = prepared.policyOverride
        ? { policy: prepared.policyOverride, reason: 'ephemeral_side_channel' }
        : policyForRequest(cfg.toolPolicy, req);
      if (pickedPolicy.reason !== 'config') log(`工具权限按请求调整：${pickedPolicy.policy}（${pickedPolicy.reason}）`);
      try {
        const result = await promptAll(prepared.sessionId, firstText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        }, lastUserImages(messages), lastUserDocs(messages), stats, pickedPolicy.policy, concreteModel);
        const message = { role: 'assistant', content: text };
        if (thought) message.reasoning_content = thought;
        return json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message, finish_reason: finishReason(result && result.stopReason) }],
          usage: usageFor(firstText, text, thought, stats),
        });
      } catch (error) {
        return oaiError(res, error.code === 'QUEUE_TIMEOUT' || error.code === 'QUEUE_FULL' ? 429 : 502,
          `Antigravity 调用失败：${error.message}`.slice(0, 500), (error.acp && error.acp.data && error.acp.data.reason) || error.code || 'prompt_failed');
      } finally {
        if (prepared.cleanup) await prepared.cleanup();
      }
    }

    if (cfg.bridgeTools !== false && Array.isArray(req.tools) && req.tools.length > 0) {
      // 默认只走桥接：工具由 PI-Desktop 执行。要用运行时自带工具，必须在面板关闭「工具回交」。
      try {
        return await chatBridged(res, req, messages, stats, cfg, model, effort);
      } catch (error) {
        if (res.headersSent) throw error;
        log(`工具回交启动失败：${String(error.message).slice(0, 160)}`);
        return oaiError(res, 502, `工具回交启动失败：${String(error.message).slice(0, 200)}（如需改用运行时自带工具，请在面板关闭「工具回交」）`, 'bridge_failed');
      }
    }
    const sse = openSse(res, {
      onAbort: ({ elapsed, frames, gap }) => log(`流被客户端中断 ${id.slice(-8)}：历时 ${elapsed} ms · 已发 ${frames} 帧 · 正文 ${text.length} 字 · 距最后一次写入 ${gap} ms`),
    });
    const send = (delta, finish = null, usage = null) => {
      const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) chunk.usage = usage;
      sse.data(chunk);
    };
    send({ role: 'assistant' });
    const startedAt = Date.now();
    const toolState = { calls: new Set(), failed: new Set(), lastLabel: '', repeat: 0 };
    let cleanupSession = null;
    try {
      await ensureRuntime();
      await acp.discover();
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await prepareNonBridgedSession(concreteModel, messages, req, cfg);
      cleanupSession = prepared.cleanup;
      task.sessionId = prepared.sessionId;
      const promptText = prepared.resume ? lastUserText(messages) : flatten(messages);
      log(`chat ${model} → ${concreteModel}（effort=${effort || '默认'}，${prepared.ephemeral ? '临时会话' : (prepared.resume ? '续会话' : '新会话')}）${ignoredFor(req)}`);
      const pickedPolicy = prepared.policyOverride
        ? { policy: prepared.policyOverride, reason: 'ephemeral_side_channel' }
        : policyForRequest(cfg.toolPolicy, req);
      if (pickedPolicy.reason !== 'config') log(`工具权限按请求调整：${pickedPolicy.policy}（${pickedPolicy.reason}）`);
      log(`首帧 ${Date.now() - startedAt} ms（含预热与建会话）`);
      const result = await promptAll(prepared.sessionId, promptText, (u) => {
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
          text += u.content.text;
          send({ content: u.content.text }, null, usageFor(promptText, text, thought, stats));
          return;
        }
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
          thought += u.content.text;
          send({ reasoning_content: u.content.text }, null, usageFor(promptText, text, thought, stats));
          return;
        }
        if (u.sessionUpdate === 'usage_update') { send({}, null, usageFor(promptText, text, thought, stats)); return; }
        // 工具进度：不进正文，只作为「思考」增量，免得几十秒里界面一片死寂
        const progress = progressLine(toolState, u);
        if (progress) {
          thought += progress;
          send({ reasoning_content: progress }, null, usageFor(promptText, text, thought, stats));
        }
      }, lastUserImages(messages), lastUserDocs(messages), stats, pickedPolicy.policy, concreteModel);
      const tail = progressLine(toolState, null, true);
      if (tail) { thought += tail; send({ reasoning_content: tail }, null, usageFor(promptText, text, thought, stats)); }
      send({}, finishReason(result && result.stopReason), usageFor(promptText, text, thought, stats));
      sse.done();
      sse.end();
    } catch (error) {
      const message = `Antigravity 调用失败：${String(error.message).slice(0, 400)}`;
      if (text) {
        // 已经吐过正文：先把这一轮正常收尾，别让客户端把一个写了一半的答案当成错误丢掉
        send({}, 'length', usageFor('', text, thought, stats));
        sse.done();
        log(`流式中断（已保留 ${text.length} 字）：${message.slice(0, 200)}`);
      } else {
        sse.data({ error: { message, type: 'antigravity_acp', code: error.code || 'prompt_failed' } });
      }
      sse.end();
    } finally {
      if (cleanupSession) await cleanupSession();
    }
  }

  async function responses(res, body, httpReq = {}) {
    let req;
    try { req = JSON.parse(body || '{}'); } catch { return oaiError(res, 400, '请求体不是合法 JSON', 'invalid_json'); }
    logRequestIds(httpReq, req, 'responses');
    const cfg = getConfig();
    const messages = normalizeMessages(req, { responses: true });
    if (!messages.some((m) => m.role === 'user')) return oaiError(res, 400, 'input 不能为空', 'invalid_request');
    const model = String(req.model || cfg.defaultModel);
    const effort = req.reasoning_effort || (req.reasoning && req.reasoning.effort) || (req.thinking && req.thinking.effort) || req.thinking_effort || cfg.defaultEffort || undefined;
    const stream = req.stream === true;
    const reqKey = keyFor(messages, req);
    const stats = { toolCounts: new Map(), estimateContext: countTokens(flatten(messages)) };
    seedSessionStats(reqKey, stats);
    const task = { sessionId: null, sessionKey: reqKey, cancelled: false, active: false };
    stats.task = task;
    watchDisconnect(res, task);

    const id = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    const rsId = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
    let text = '';
    let thought = '';
    let promptText = '';

    const envelope = (status, includeOutput) => {
      const out = { id, object: 'response', created_at: createdAt, status, model };
      if (includeOutput) {
        const output = [];
        output.push({ type: 'message', id: msgId, status: status === 'incomplete' ? 'incomplete' : 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
        if (thought) output.push({ type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: thought }] });
        out.output = output;
        if (status === 'incomplete') out.incomplete_details = { reason: 'stream_interrupted' };
        const usage = usageFor(promptText, text, thought, stats);
        out.usage = {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          estimated: usage.estimated !== false,
          ...usage.context_used !== undefined ? { context_used: usage.context_used } : {},
          ...usage.context_size !== undefined ? { context_size: usage.context_size } : {},
        };
      }
      return out;
    };

    if (!stream) {
      await ensureRuntime();
      await acp.discover();
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await prepareNonBridgedSession(concreteModel, messages, req, cfg);
      task.sessionId = prepared.sessionId;
      promptText = prepared.resume ? lastUserText(messages) : flatten(messages);
      log(`responses ${model} → ${concreteModel}（effort=${effort || '默认'}，${prepared.ephemeral ? '临时会话' : (prepared.resume ? '续会话' : '新会话')}）${ignoredFor(req)}`);
      const pickedPolicy = prepared.policyOverride
        ? { policy: prepared.policyOverride, reason: 'ephemeral_side_channel' }
        : policyForRequest(cfg.toolPolicy, req);
      if (pickedPolicy.reason !== 'config') log(`工具权限按请求调整：${pickedPolicy.policy}（${pickedPolicy.reason}）`);
      try {
        await promptAll(prepared.sessionId, promptText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        }, lastUserImages(messages), lastUserDocs(messages), stats, pickedPolicy.policy, concreteModel);
        return json(res, 200, envelope('completed', true));
      } catch (error) {
        return oaiError(res, error.code === 'QUEUE_TIMEOUT' || error.code === 'QUEUE_FULL' ? 429 : 502,
          `Antigravity 调用失败：${error.message}`.slice(0, 500), error.code || 'prompt_failed');
      } finally {
        if (prepared.cleanup) await prepared.cleanup();
      }
    }

    if (cfg.bridgeTools !== false && Array.isArray(req.tools) && req.tools.length > 0) {
      try {
        return await responsesBridged(res, req, messages, stats, cfg, model, effort);
      } catch (error) {
        if (res.headersSent) throw error;
        log(`工具回交启动失败（Responses）：${String(error.message).slice(0, 160)}`);
        return oaiError(res, 502, `工具回交启动失败：${String(error.message).slice(0, 200)}（如需改用运行时自带工具，请在面板关闭「工具回交」）`, 'bridge_failed');
      }
    }
    const sse = openSse(res, {
      onAbort: ({ elapsed, frames, gap }) => log(`流被客户端中断 ${id.slice(-8)}：历时 ${elapsed} ms · 已发 ${frames} 帧 · 正文 ${text.length} 字 · 距最后一次写入 ${gap} ms`),
    });
    const emit = (type, payload) => sse.event(type, payload);
    let messageOpen = false;
    const openMessage = () => {
      if (messageOpen) return;
      messageOpen = true;
      emit('response.output_item.added', { output_index: 0, item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };
    // 宿主（openai-responses-shared:474-486）只在拿到 output_item.added(type=reasoning)
    // 之后才会为 response.reasoning_summary_text.delta 建「思考」槽位。
    // 之前我把工具进度写成 SSE 注释帧，宿主直接丢弃——这就是「看不到任何思考/工具调用」。
    const REASONING_INDEX = 1;
    let reasoningOpen = false;
    const openReasoning = () => {
      if (reasoningOpen) return;
      reasoningOpen = true;
      emit('response.output_item.added', { output_index: REASONING_INDEX, item: { type: 'reasoning', id: rsId, summary: [] } });
      emit('response.reasoning_summary_part.added', { item_id: rsId, output_index: REASONING_INDEX, summary_index: 0, part: { type: 'summary_text', text: '' } });
    };
    const reasoningDelta = (delta) => {
      if (!delta) return;
      openReasoning();
      emit('response.reasoning_summary_text.delta', { item_id: rsId, output_index: REASONING_INDEX, summary_index: 0, delta });
    };
    const closeReasoning = () => {
      if (!reasoningOpen) return;
      emit('response.reasoning_summary_part.done', { item_id: rsId, output_index: REASONING_INDEX, summary_index: 0, part: { type: 'summary_text', text: thought } });
      emit('response.output_item.done', { output_index: REASONING_INDEX, item: { type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: thought }] } });
    };
    emit('response.created', { response: envelope('in_progress', false) });
    emit('response.in_progress', { response: envelope('in_progress', false) });
    const startedAt = Date.now();
    let cleanupSession = null;
    try {
      await ensureRuntime();
      await acp.discover();
      const concreteModel = await acp.resolveModel(model, effort);
      const prepared = await prepareNonBridgedSession(concreteModel, messages, req, cfg);
      cleanupSession = prepared.cleanup;
      task.sessionId = prepared.sessionId;
      promptText = prepared.resume ? lastUserText(messages) : flatten(messages);
      log(`responses ${model} → ${concreteModel}（effort=${effort || '默认'}，${prepared.ephemeral ? '临时会话' : (prepared.resume ? '续会话' : '新会话')}）${ignoredFor(req)}`);
      const pickedPolicy = prepared.policyOverride
        ? { policy: prepared.policyOverride, reason: 'ephemeral_side_channel' }
        : policyForRequest(cfg.toolPolicy, req);
      if (pickedPolicy.reason !== 'config') log(`工具权限按请求调整：${pickedPolicy.policy}（${pickedPolicy.reason}）`);
      log(`首帧 ${Date.now() - startedAt} ms（含预热与建会话）`);
      const toolState = { calls: new Set(), failed: new Set(), lastLabel: '', repeat: 0 };
      let needBreak = false;
      const finalResult = await promptAll(prepared.sessionId, promptText, (u) => {
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) { thought += u.content.text; reasoningDelta(u.content.text); return; }
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
          let piece = u.content.text;
          // 工具调用前后的两段播报属于不同的「发言段」：不补空行就会粘成一整句（实测就是这么粘的）
          if (needBreak && text.trim() && piece.trim()) piece = `\n\n${piece}`;
          if (piece.trim()) needBreak = false;
          text += piece;
          openMessage();
          emit('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: piece });
          return;
        }
        if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          if (text.length > 0) needBreak = true;
          const progress = progressLine(toolState, u);
          if (progress && !res.writableEnded) {
            thought += progress;
            reasoningDelta(progress);
          }
        }
      }, lastUserImages(messages), lastUserDocs(messages), stats, pickedPolicy.policy, concreteModel);
      const capped = (stats.lastRoundTools || 0) > 0 && (stats.lastRoundText || 0) === 0;
      if (capped) log('续跑到上限仍未结束：本轮按未完成收尾');

      const tail = progressLine(toolState, null, true);
      if (tail && !res.writableEnded) { thought += tail; reasoningDelta(tail); }
      closeReasoning();
      openMessage();
      emit('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
      emit('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      emit('response.output_item.done', { output_index: 0, item: { type: 'message', id: msgId, status: capped ? 'incomplete' : 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
      emit(capped ? 'response.incomplete' : 'response.completed', { response: envelope(capped ? 'incomplete' : 'completed', true) });
      sse.end();
    } catch (error) {

      const message = `Antigravity 调用失败：${String(error.message).slice(0, 400)}`;
      if (text) {
        // 已经有过正文：按 incomplete 正常收尾，保住已生成的内容
        closeReasoning();
        openMessage();
        emit('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
        emit('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
        emit('response.incomplete', { response: envelope('incomplete', true) });
        log(`流式中断（已保留 ${text.length} 字）：${message.slice(0, 200)}`);
      } else {
        emit('response.failed', { response: { id, object: 'response', created_at: createdAt, status: 'failed', model, error: { code: error.code || 'prompt_failed', message } } });
      }
      sse.end();
    } finally {
      if (cleanupSession) await cleanupSession();
    }
  }

  const handler = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With, baggage, sentry-trace',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return await listModels(res);
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) return await chat(res, await readBody(req), req);
      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) return await responses(res, await readBody(req), req);
      if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, {
              ok: true, ...acp.status(), limiter: limiter.stats(), port,
              toolPolicy: getConfig().toolPolicy, sessions: sessions.size, lastRequest,
            });
      }
      oaiError(res, 404, `未知路径 ${url.pathname}`, 'not_found');
    } catch (error) {
      if (error && error.code === 'BODY_TOO_LARGE') {
        return oaiError(res, 413, error.message, 'payload_too_large');
      }
      oaiError(res, 502, String(error.message).slice(0, 400), error.code || 'gateway_error');
    }
  });

  // requestTimeout governs receipt of the request body, not response generation.
  handler.requestTimeout = 300000;
  handler.headersTimeout = 120000;
  handler.keepAliveTimeout = 120000;
  handler.timeout = 0;

  return {
    async listen(portCandidates) {
      const cfg = getConfig();
      const candidates = Array.isArray(portCandidates) && portCandidates.length ? portCandidates : [cfg.port];
      for (const candidate of candidates) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => { handler.removeListener('listening', onListening); reject(error); };
            const onListening = () => { handler.removeListener('error', onError); resolve(); };
            handler.once('error', onError);
            handler.once('listening', onListening);
            handler.listen(candidate, cfg.bind);
          });
          port = (handler.address() && handler.address().port) || candidate;
          server = handler;
          log(`网关监听 http://${cfg.bind}:${port}（并发上限 ${cfg.concurrency > 0 ? cfg.concurrency : '不限'}，工具回交=${cfg.bridgeTools === true ? '开' : '关'}）`);
          return port;
        } catch (error) {
          if (error.code !== 'EADDRINUSE') throw error;
          log(`端口 ${candidate} 被占用，尝试下一个`);
        }
      }
      throw new Error('没有可用端口');
    },
    close() {
      clearInterval(idleSweepTimer);
      clearAllBridges('网关已关闭');
      try { if (mcpBridge) { mcpBridge.close(); mcpBridge = null; mcpUrl = ''; } } catch { /* ignore */ }
      try { if (server) server.close(); } catch { /* ignore */ }
      server = null;
      port = null;
      // 内存映射清掉，但足迹要落盘：重启后靠 session/load 接回同一轮对话。
      try { sessionStore.flush(); } catch { /* ignore */ }
      sessions.clear();
      handlers.clear();
      try { acp.policyBySession?.clear?.(); } catch { /* ignore */ }
    },
    status() {
      return { port, ...acp.status(), limiter: limiter.stats(), lastRequest };
    },
    sessions: () => sessions.size,
    listSessions() {
      const now = Date.now();
      const list = [];
      for (const [key, value] of sessions) {
        list.push({
          key,
          sessionId: value.sessionId,
          model: value.model || '',
          ageSeconds: Math.max(0, Math.round((now - (value.touched || now)) / 1000)),
          closed: Boolean(value.closed),
          inflight: value.inflight || 0,
          bridged: Boolean(value.bridgeUrl),
          contextUsed: value.contextUsed || 0,
          contextSize: value.contextSize || 0,
        });
      }
      return list;
    },
    async recycleSessions() {
      let count = 0;
      for (const [key, value] of sessions) {
        if (value.inflight > 0) continue;
        if (!value.closed) {
          value.closed = true;
          count += 1;
          await closeSession(value.sessionId);
        }
      }
      sessionStore.flush();
      log(`手动一键回收闲置会话：已回收 ${count} 个活跃会话`);
      return { ok: true, recycled: count, total: sessions.size };
    },
    /** 面板「重启运行时」：杀掉进程树并清掉会话映射，下次请求由 ensureRuntime() 拉起。 */
    restartRuntime(reason = 'manual') {
      const stopped = typeof acp.restart === 'function'
        ? acp.restart(reason)
        : (() => { acp.kill(); return { pid: 0, stopped: true }; })();
      clearAllBridges('运行时已重启');
      sessions.clear();
      handlers.clear();
      acp.policyBySession.clear();
      log(`运行时已按需重启（${reason}）`);
      return stopped;
    },
  };
}

module.exports = {
  createGateway, normalizeMessages, buildPromptBlocks, collectImageUrls, imageBlock, lastUserImages,
  collectDocuments, documentBlock, readDocumentBytes, lastUserDocs, countTokens, usageFor, ignoredParams, keyFor,
  policyForRequest, hasWebSearchTool, appendUsage, flatten, canonicalizeText,
};
