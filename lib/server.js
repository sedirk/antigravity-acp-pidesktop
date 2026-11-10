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

const MAX_BODY = 32 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length), 'cache-control': 'no-store' });
  res.end(payload);
}

function oaiError(res, status, message, code = 'antigravity_error') {
  json(res, status, { error: { message, type: 'antigravity_acp', code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
async function readDocumentBytes(doc) {
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
async function documentBlock(doc, attachmentsDir) {
  if (doc.unsupported === 'file_id') {
    return { block: { type: 'text', text: `（附件 ${doc.name} 以 file_id 形式提供，插件无法从 OpenAI Files 接口取回，已跳过）` }, persisted: null };
  }
  const payload = await readDocumentBytes(doc);
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
async function buildPromptBlocks(text, urls = [], docs = [], attachmentsDir = path.join(os.tmpdir(), 'antigravity-acp-attachments')) {
  const blocks = [{ type: 'text', text }];
  for (const url of urls) {
    const block = await imageBlock(url);
    if (block) blocks.push(block);
    else blocks.push({ type: 'text', text: `（有一张图片无法读取：${String(url).slice(0, 80)}）` });
  }
  for (const doc of docs) {
    const { block } = await documentBlock(doc, attachmentsDir);
    if (block) blocks.push(block);
  }
  return blocks;
}

function normalizeMessages(body, { responses = false } = {}) {
  const out = [];
  if (responses && typeof body.instructions === 'string' && body.instructions) out.push({ role: 'system', content: body.instructions });
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) out.push({ role: (m && m.role) || 'user', content: textOf(m && m.content), images: collectImageUrls(m && m.content), documents: collectDocuments(m && m.content) });
  }
  if (responses && body.input !== undefined) {
    if (typeof body.input === 'string') out.push({ role: 'user', content: body.input });
    else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === 'string') { out.push({ role: 'user', content: item }); continue; }
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message' || item.role) out.push({ role: item.role || 'user', content: textOf(item.content), images: collectImageUrls(item.content), documents: collectDocuments(item.content) });
        else if (item.type === 'input_text' || item.type === 'text') out.push({ role: 'user', content: item.text || '' });
      }
    }
  }
  return out;
}

function flatten(messages) {
  return messages.map((m) => {
    const who = m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User';
    return `${who}:\n${m.content}`;
  }).join('\n\n');
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last ? last.content : '';
}

/**
 * 会话键：同一模型 + 相同的历史前缀 → 复用同一个 ACP 会话。
 * 单轮对话（只有一条 user 消息）历史前缀为空，必须补判别位，
 * 否则任意两个单轮对话都会撞进同一个会话——实测会把 A 的上下文带给 B。
 */
function keyFor(model, messages) {
  const head = messages.slice(0, -1).map((m) => `${m.role}:${m.content}:${(m.images || []).length}`).join('\u0000');
  const seed = head || `single:${messages.length > 0 ? `${messages[0].role}:${messages[0].content}` : ''}`;
  return crypto.createHash('sha256').update(`${model}\u0001${seed}`).digest('hex').slice(0, 32);
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
 * ACP 只发 usage_update{used,size}（上下文累计占用，实测 11160→11643），没有单次 token 数，
 * 所以 token 数是估算的；context_used / context_size 是运行时给的真实值。
 */
function usageFor(promptText, text, thought, stats = null) {
  const prompt = countTokens(promptText);
  const completion = countTokens(text) + countTokens(thought);
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: true };
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

const POLICIES = ['search', 'agent', 'shell', 'all', 'none'];

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

/** 每次请求追加一行用量统计（JSONL），文件超过 5MB 就轮转一次。 */
function appendUsage(config, record) {
  try {
    const source = String((config && config.source) || '');
    const dir = source && source !== '(默认值)' ? path.dirname(source) : path.join(os.tmpdir(), 'antigravity-acp');
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
  let server = null;
  let lastRequest = null;
  let port = null;

  let activePrompts = 0;
  const idleSessionMs = () => Math.max(Number(getConfig().idleSessionMinutes) || 10, 1) * 60000;

  // 运行时重启/被杀后，旧的 sessionId 全部失效，必须清空，否则后续请求会拿废会话去 prompt。
  acp.onExit = () => {
    if (sessions.size > 0) log(`运行时已退出，清空 ${sessions.size} 个会话缓存`);
    sessions.clear();
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
   * 客户端断开：ACP 的 session/cancel 是「通知」（无 id、不等回复），实测能让本轮以
   * stopReason=cancelled 结束，而且保留进程与会话记忆。旧版直接杀运行时是下策。
   * 兜底判断用会话的 inflight 计数：取消后 20 秒还在一轮里，才结束运行时。
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
      if (!task.sessionId) return;
      acp.notify('session/cancel', { sessionId: task.sessionId });
      log(`已发送 session/cancel 通知（保留运行时与会话 ${String(task.sessionId).slice(0, 8)}…）`);
      setTimeout(() => {
        const entry = [...sessions.values()].find((v) => v.sessionId === task.sessionId);
        if (!entry || entry.inflight === 0) return;
        log('取消后 20 秒本轮仍未结束：结束运行时兜底');
        acp.kill();
        sessions.clear();
      }, 20000).unref();
    });
  }

  acp.onNotification = (msg) => {
    if (msg.method !== 'session/update') return;
    const sessionId = msg.params && msg.params.sessionId;
    const handler = handlers.get(sessionId);
    if (typeof handler === 'function') handler(msg.params.update || {});
  };

  // 空闲回收：用 session/close 把 worker 放掉，但保留映射，下次发言优先 session/resume。
  setInterval(() => {
    const now = Date.now();
    const limit = idleSessionMs();
    for (const [key, value] of sessions) {
      if (value.inflight > 0) continue;
      if (value.closed) {
        if (now - value.touched > limit * 6) sessions.delete(key);
        continue;
      }
      if (now - value.touched >= limit) {
        value.closed = true;
        closeSession(value.sessionId);
        log(`空闲回收：session/close ${String(value.sessionId).slice(0, 8)}…（下次可 resume）`);
      }
    }
  }, 60000).unref();

  async function sessionFor(model, messages) {
    const cfg = getConfig();
    const key = keyFor(model, messages);
    const cwd = cfg.cwd || path.dirname(cfg.bin || '.');
    const hit = sessions.get(key);
    if (hit) {
      hit.touched = Date.now();
      if (!hit.closed) return { sessionId: hit.sessionId, resume: true, key };
      try {
        await acp.request('session/resume', { sessionId: hit.sessionId, cwd, mcpServers: [] }, 45000);
        hit.closed = false;
        log(`已 resume 会话 ${String(hit.sessionId).slice(0, 8)}…（不重放历史）`);
        return { sessionId: hit.sessionId, resume: true, key };
      } catch (error) {
        log(`session/resume 失败：${String(error.message).slice(0, 120)}；改为新建会话`);
        await closeSession(hit.sessionId);
        sessions.delete(key);
      }
    }
    const created = await acp.request('session/new', { cwd, mcpServers: [] }, 60000);
    if (model && created.models && created.models.currentModelId !== model) {
      const switchModel = () => acp.request('session/set_model', { sessionId: created.sessionId, modelId: model }, 30000);
      try {
        await switchModel();
      } catch (first) {
        log(`set_model 失败，重试一次：${String(first.message).slice(0, 160)}`);
        try {
          await acp.start();
          await switchModel();
        } catch (second) {
          // 关键：切换失败时绝不拿会话默认模型冒充用户选的模型
          throw Object.assign(
            new Error(`无法切换到模型 ${model}（${String(second.message).slice(0, 120)}）；已拒绝改用其它模型回答`),
            { code: 'MODEL_SWITCH_FAILED' },
          );
        }
      }
    }
    sessions.set(key, { sessionId: created.sessionId, model, touched: Date.now(), closed: false, inflight: 0 });
    if (sessions.size > cfg.maxSessions) {
      const idle = [...sessions.entries()]
        .filter(([k, v]) => k !== key && !v.closed && v.inflight === 0)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (idle) {
        idle[1].closed = true;
        closeSession(idle[1].sessionId);
        log(`会话数超过上限 ${cfg.maxSessions}：已 session/close 最久未用的会话`);
      } else {
        const stale = [...sessions.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (stale) { sessions.delete(stale[0]); log('会话数超过上限且其它会话都在忙：丢弃最久未用的本地记录'); }
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
    const attachDir = attachmentsPath || path.join(cfg.cwd || path.dirname(cfg.bin || '.'), '.attachments');
    const blocks = await buildPromptBlocks(text, imageUrls, docs, attachDir);
    if (imageUrls.length > 0 || docs.length > 0) {
      const images = blocks.filter((b) => b.type === 'image');
      const links = blocks.filter((b) => b.type === 'resource_link');
      const parts = [];
      if (imageUrls.length > 0) parts.push(`图片 ${images.length}/${imageUrls.length}`);
      if (docs.length > 0) parts.push(`文档 ${links.length}/${docs.length}（${links.map((b) => b.mimeType).join(', ') || '全部读取失败'}）`);
      log(`prompt 携带 ${parts.join('，')}`);
    }
    return limiter.run(async () => {
      activePrompts += 1;
      if (policy) acp.policyBySession.set(sessionId, policy);
      const owner = [...sessions.values()].find((v) => v.sessionId === sessionId);
      if (owner) owner.inflight += 1;
      const wrapped = (u) => {
        if (u && u.sessionUpdate === 'tool_call') {
          const kind = String(u.kind || 'other');
          stats.toolCounts.set(kind, (stats.toolCounts.get(kind) || 0) + 1);
          if (kind === 'search' || kind === 'fetch') log(`工具调用：${String(u.title || kind).slice(0, 60)}`);
        }
        if (u && u.sessionUpdate === 'usage_update') {
          if (Number.isFinite(u.used)) stats.contextUsed = u.used;
          if (Number.isFinite(u.size)) stats.contextSize = u.size;
        }
        if (typeof onUpdate === 'function') onUpdate(u);
      };
      if (typeof onUpdate === 'function') handlers.set(sessionId, wrapped);
      try {
        return await acp.request('session/prompt', { sessionId, prompt: blocks }, cfg.promptTimeoutMs);
      } finally {
        activePrompts -= 1;
        handlers.delete(sessionId);
        if (owner) owner.inflight = Math.max(0, owner.inflight - 1);
        if (stats.toolCounts.size > 0) log(`本次工具使用：${[...stats.toolCounts.entries()].map(([k, v]) => `${k}×${v}`).join('，')}`);
        if (stats.contextUsed) log(`上下文占用 ${stats.contextUsed}/${stats.contextSize} token`);
        if (policy) acp.policyBySession.delete(sessionId);
        lastRequest = {
          at: new Date().toISOString(),
          session: String(sessionId).slice(0, 8),
          policy: policy || cfg.toolPolicy,
          ms: Date.now() - startedAt,
          contextUsed: stats.contextUsed || 0,
          contextSize: stats.contextSize || 0,
          tools: Object.fromEntries(stats.toolCounts),
        };
        appendUsage(cfg, lastRequest);
      }
    });
  }

  async function listModels(res) {
    const data = await acp.modelsForApi();
    json(res, 200, { object: 'list', data });
  }

  async function chat(res, body) {
    let req;
    try { req = JSON.parse(body || '{}'); } catch { return oaiError(res, 400, '请求体不是合法 JSON', 'invalid_json'); }
    const cfg = getConfig();
    const messages = normalizeMessages(req);
    if (!messages.some((m) => m.role === 'user')) return oaiError(res, 400, 'messages 不能为空', 'invalid_request');
    const model = String(req.model || cfg.defaultModel);
    const effort = req.reasoning_effort || cfg.defaultEffort || undefined;
    const stream = req.stream === true;
    const stats = { toolCounts: new Map() };
    const task = { sessionId: null };
    watchDisconnect(res, task);

    await acp.start();
    await acp.discover();
    const concrete = acp.resolveModel(model, effort);
    const { sessionId, resume } = await sessionFor(concrete, messages);
    task.sessionId = sessionId;
    const promptText = resume ? lastUserText(messages) : flatten(messages);
    const ignored = ignoredParams(req);
    log(`chat ${model} → ${concrete}（effort=${effort || '默认'}，${resume ? '续会话' : '新会话'}）${ignored.length ? ` · 运行时忽略 ${ignored.join(',')}` : ''}`);
    const picked = policyForRequest(cfg.toolPolicy, req);
    if (picked.reason !== 'config') log(`工具权限按请求调整：${picked.policy}（${picked.reason}）`);

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let text = '';
    let thought = '';

    if (!stream) {
      try {
        const result = await prompt(sessionId, promptText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        }, lastUserImages(messages), lastUserDocs(messages), stats, picked.policy);
        const message = { role: 'assistant', content: text };
        if (thought) message.reasoning_content = thought;
        return json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message, finish_reason: finishReason(result && result.stopReason) }],
          usage: usageFor(promptText, text, thought, stats),
        });
      } catch (error) {
        return oaiError(res, error.code === 'QUEUE_TIMEOUT' || error.code === 'QUEUE_FULL' ? 429 : 502,
          `Antigravity 调用失败：${error.message}`.slice(0, 500), (error.acp && error.acp.data && error.acp.data.reason) || error.code || 'prompt_failed');
      }
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (delta, finish = null, usage = null) => {
      if (res.writableEnded) return;
      const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) chunk.usage = usage;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    send({ role: 'assistant' });
    try {
      const result = await prompt(sessionId, promptText, (u) => {
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) { text += u.content.text; send({ content: u.content.text }); }
        else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) { thought += u.content.text; send({ reasoning_content: u.content.text }); }
      }, lastUserImages(messages), lastUserDocs(messages), stats, picked.policy);
      send({}, finishReason(result && result.stopReason), usageFor(promptText, text, thought, stats));
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'antigravity_acp', code: error.code || 'prompt_failed' } })}\n\n`);
        res.end();
      }
    }
  }

  async function responses(res, body) {
    let req;
    try { req = JSON.parse(body || '{}'); } catch { return oaiError(res, 400, '请求体不是合法 JSON', 'invalid_json'); }
    const cfg = getConfig();
    const messages = normalizeMessages(req, { responses: true });
    if (!messages.some((m) => m.role === 'user')) return oaiError(res, 400, 'input 不能为空', 'invalid_request');
    const model = String(req.model || cfg.defaultModel);
    const effort = (req.reasoning && req.reasoning.effort) || req.reasoning_effort || cfg.defaultEffort || undefined;
    const stream = req.stream === true;
    const stats = { toolCounts: new Map() };
    const task = { sessionId: null };
    watchDisconnect(res, task);

    await acp.start();
    await acp.discover();
    const concrete = acp.resolveModel(model, effort);
    const { sessionId, resume } = await sessionFor(concrete, messages);
    task.sessionId = sessionId;
    const promptText = resume ? lastUserText(messages) : flatten(messages);
    const ignored = ignoredParams(req);
    log(`responses ${model} → ${concrete}（effort=${effort || '默认'}，${resume ? '续会话' : '新会话'}）${ignored.length ? ` · 运行时忽略 ${ignored.join(',')}` : ''}`);
    const picked = policyForRequest(cfg.toolPolicy, req);
    if (picked.reason !== 'config') log(`工具权限按请求调整：${picked.policy}（${picked.reason}）`);

    const id = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    const rsId = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
    let text = '';
    let thought = '';

    const envelope = (status, includeOutput) => {
      const out = { id, object: 'response', created_at: createdAt, status, model };
      if (includeOutput) {
        const output = [];
        if (thought) output.push({ type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: thought }] });
        output.push({ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
        out.output = output;
        const usage = usageFor(promptText, text, thought, stats);
        out.usage = {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          estimated: true,
          ...usage.context_used !== undefined ? { context_used: usage.context_used } : {},
          ...usage.context_size !== undefined ? { context_size: usage.context_size } : {},
        };
      }
      return out;
    };

    if (!stream) {
      try {
        await prompt(sessionId, promptText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        }, lastUserImages(messages), lastUserDocs(messages), stats, picked.policy);
        return json(res, 200, envelope('completed', true));
      } catch (error) {
        return oaiError(res, error.code === 'QUEUE_TIMEOUT' || error.code === 'QUEUE_FULL' ? 429 : 502,
          `Antigravity 调用失败：${error.message}`.slice(0, 500), error.code || 'prompt_failed');
      }
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let seq = 0;
    const emit = (type, payload) => {
      if (res.writableEnded) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: seq++ })}\n\n`);
    };
    let messageOpen = false;
    const openMessage = () => {
      if (messageOpen) return;
      messageOpen = true;
      emit('response.output_item.added', { output_index: 0, item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };
    emit('response.created', { response: envelope('in_progress', false) });
    try {
      await prompt(sessionId, promptText, (u) => {
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) { thought += u.content.text; return; }
        if (u.sessionUpdate !== 'agent_message_chunk' || !u.content || !u.content.text) return;
        text += u.content.text;
        openMessage();
        emit('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: u.content.text });
      }, lastUserImages(messages), lastUserDocs(messages), stats, picked.policy);
      openMessage();
      emit('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
      emit('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      emit('response.output_item.done', { output_index: 0, item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
      emit('response.completed', { response: envelope('completed', true) });
      res.end();
    } catch (error) {
      emit('response.failed', { response: { id, object: 'response', created_at: createdAt, status: 'failed', model, error: { code: error.code || 'prompt_failed', message: String(error.message).slice(0, 400) } } });
      res.end();
    }
  }

  const handler = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return await listModels(res);
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) return await chat(res, await readBody(req));
      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) return await responses(res, await readBody(req));
      if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, {
              ok: true, ...acp.status(), limiter: limiter.stats(), port,
              toolPolicy: getConfig().toolPolicy, sessions: sessions.size, lastRequest,
            });
      }
      oaiError(res, 404, `未知路径 ${url.pathname}`, 'not_found');
    } catch (error) {
      oaiError(res, 502, String(error.message).slice(0, 400), error.code || 'gateway_error');
    }
  });

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
          port = candidate;
          server = handler;
          log(`网关监听 http://${cfg.bind}:${port}（并发上限 ${cfg.concurrency > 0 ? cfg.concurrency : '不限'}）`);
          return port;
        } catch (error) {
          if (error.code !== 'EADDRINUSE') throw error;
          log(`端口 ${candidate} 被占用，尝试下一个`);
        }
      }
      throw new Error('没有可用端口');
    },
    close() {
      try { if (server) server.close(); } catch { /* ignore */ }
      server = null;
      port = null;
      sessions.clear();
      handlers.clear();
      acp.policyBySession.clear();
    },
    status() {
      return { port, ...acp.status(), limiter: limiter.stats(), lastRequest };
    },
    sessions: () => sessions.size,
  };
}

module.exports = {
  createGateway, normalizeMessages, buildPromptBlocks, collectImageUrls, imageBlock, lastUserImages,
  collectDocuments, documentBlock, lastUserDocs, countTokens, usageFor, ignoredParams, keyFor,
  policyForRequest, hasWebSearchTool, appendUsage,
};
