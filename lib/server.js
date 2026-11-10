'use strict';

/**
 * OpenAI 兼容 HTTP 层：/v1/models、/v1/chat/completions、/v1/responses、/health。
 *
 * 每条 prompt 通过并发限制器排队；session/update 按 sessionId 路由到对应请求，
 * 因此 limit>1 时并发的两条流不会串台。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 32 * 1024 * 1024;

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
    if (c.type === 'image_url' || c.type === 'input_image') return '[图片已忽略]';
    return '';
  }).join('');
}

function normalizeMessages(body, { responses = false } = {}) {
  const out = [];
  if (responses && typeof body.instructions === 'string' && body.instructions) out.push({ role: 'system', content: body.instructions });
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) out.push({ role: (m && m.role) || 'user', content: textOf(m && m.content) });
  }
  if (responses && body.input !== undefined) {
    if (typeof body.input === 'string') out.push({ role: 'user', content: body.input });
    else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === 'string') { out.push({ role: 'user', content: item }); continue; }
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message' || item.role) out.push({ role: item.role || 'user', content: textOf(item.content) });
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

function keyFor(model, messages) {
  const head = messages.slice(0, -1).map((m) => `${m.role}:${m.content}`).join('\u0000');
  return crypto.createHash('sha256').update(`${model}\u0001${head}`).digest('hex').slice(0, 32);
}

function finishReason(stopReason) {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

function createGateway({ acp, limiter, getConfig, log = () => {} }) {
  const sessions = new Map();
  const handlers = new Map();
  let server = null;
  let port = null;

  acp.onNotification = (msg) => {
    if (msg.method !== 'session/update') return;
    const sessionId = msg.params && msg.params.sessionId;
    const handler = handlers.get(sessionId);
    if (typeof handler === 'function') handler(msg.params.update || {});
  };

  setInterval(() => {
    const cfg = getConfig();
    const now = Date.now();
    for (const [key, value] of sessions) if (now - value.touched > Math.max(cfg.promptTimeoutMs, 600000)) sessions.delete(key);
  }, 60000).unref();

  async function sessionFor(model, messages) {
    const cfg = getConfig();
    const key = keyFor(model, messages);
    const hit = sessions.get(key);
    if (hit) { hit.touched = Date.now(); return { sessionId: hit.sessionId, resume: true }; }
    const created = await acp.request('session/new', { cwd: cfg.cwd || require('node:path').dirname(cfg.bin || '.'), mcpServers: [] }, 60000);
    if (model && created.models && created.models.currentModelId !== model) {
      try { await acp.request('session/set_model', { sessionId: created.sessionId, modelId: model }, 30000); }
      catch (error) { log(`set_model 失败：${String(error.message).slice(0, 160)}`); }
    }
    sessions.set(key, { sessionId: created.sessionId, model, touched: Date.now() });
    if (sessions.size > cfg.maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    return { sessionId: created.sessionId, resume: false };
  }

  /** 一次 prompt：受并发限制器控制，按 sessionId 路由通知。 */
  async function prompt(sessionId, text, onUpdate) {
    const cfg = getConfig();
    return limiter.run(async () => {
      if (typeof onUpdate === 'function') handlers.set(sessionId, onUpdate);
      try {
        return await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, cfg.promptTimeoutMs);
      } finally {
        handlers.delete(sessionId);
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

    await acp.start();
    await acp.discover();
    const concrete = acp.resolveModel(model, effort);
    const { sessionId, resume } = await sessionFor(concrete, messages);
    const promptText = resume ? lastUserText(messages) : flatten(messages);

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let text = '';
    let thought = '';

    if (!stream) {
      try {
        const result = await prompt(sessionId, promptText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        });
        const message = { role: 'assistant', content: text };
        if (thought) message.reasoning_content = thought;
        return json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finishReason(result && result.stopReason) }] });
      } catch (error) {
        return oaiError(res, error.code === 'QUEUE_TIMEOUT' || error.code === 'QUEUE_FULL' ? 429 : 502,
          `Antigravity 调用失败：${error.message}`.slice(0, 500), (error.acp && error.acp.data && error.acp.data.reason) || error.code || 'prompt_failed');
      }
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (delta, finish = null) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    send({ role: 'assistant' });
    try {
      const result = await prompt(sessionId, promptText, (u) => {
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) { text += u.content.text; send({ content: u.content.text }); }
        else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) { thought += u.content.text; send({ reasoning_content: u.content.text }); }
      });
      send({}, finishReason(result && result.stopReason));
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

    await acp.start();
    await acp.discover();
    const concrete = acp.resolveModel(model, effort);
    const { sessionId, resume } = await sessionFor(concrete, messages);
    const promptText = resume ? lastUserText(messages) : flatten(messages);

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
      }
      return out;
    };

    if (!stream) {
      try {
        await prompt(sessionId, promptText, (u) => {
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) text += u.content.text;
          else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) thought += u.content.text;
        });
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
      });
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
        return json(res, 200, { ok: true, ...acp.status(), limiter: limiter.stats(), port });
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
    },
    status() {
      return { port, ...acp.status(), limiter: limiter.stats() };
    },
    sessions: () => sessions.size,
  };
}

module.exports = { createGateway, normalizeMessages };
