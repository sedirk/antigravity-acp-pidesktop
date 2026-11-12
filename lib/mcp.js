'use strict';

/**
 * 最小 MCP over Streamable HTTP（回环），只做工具桥需要的那几个方法。
 *
 * 关键约束（来自 pi-agy-acp 的实测经验）：`tools/call` 必须**立刻发响应头**，
 * 否则 ACP 运行时的 HTTP 客户端约 60 秒就放弃这次调用；因此这里用 SSE：
 * 先写头 + 注释帧，等 PI 真正执行完再把 JSON-RPC 结果写进同一路流。
 */

const http = require('node:http');

const PROTOCOL_VERSION = '2024-11-05';
const WAIT_COMMENT_MS = 15000;

/**
 * @param {object} opts
 * @param {string} opts.name 服务名
 * @param {() => Array<{name:string,description?:string,inputSchema:object}>} opts.listTools
 * @param {(call:{name:string,args:object})=>Promise<{content:Array<object>,isError?:boolean}>} opts.callTool
 */
function createMcpServer({ name = 'antigravity-acp-bridge', listTools, callTool, log = () => {} }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      // 不提供服务端主动推送
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        tooLarge = true;
        try { req.pause(); } catch { /* ignore */ }
        const errPayload = JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Payload Too Large' } });
        res.writeHead(413, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(errPayload),
          'connection': 'close',
        }).end(errPayload);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('bad json'); return; }
      handle(payload, res, req.url);
    });
  });

  function reply(res, body) {
    const text = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text);
  }
  const inFlightCalls = new Map();

  function handle(msg, res, url = '') {
    const id = msg && msg.id;
    const method = String((msg && msg.method) || '');
    if (method === 'initialize') {
      reply(res, {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (method === 'notifications/cancelled') {
      const targetId = String((msg.params && (msg.params.requestId !== undefined ? msg.params.requestId : msg.params.id)) || '');
      if (targetId && inFlightCalls.has(targetId)) {
        log(`MCP 收到取消通知：主动中止工具调用 #${targetId}`);
        const abortFn = inFlightCalls.get(targetId);
        inFlightCalls.delete(targetId);
        try { abortFn(); } catch { /* ignore */ }
      }
      res.writeHead(202).end();
      return;
    }
    if (method === 'tools/list') {
      let tools = [];
      try { tools = listTools(url) || []; } catch (error) { log(`tools/list 失败：${error && error.message}`); }
      reply(res, { jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (method === 'tools/call') {
      const params = (msg.params || {});
      const toolName = String(params.name || '');
      const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
      // 先发头，避免运行时 60 秒无头放弃
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': bridge waiting\n\n');
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, WAIT_COMMENT_MS);
      keep.unref?.();
      let settled = false;
      let onCancel = null;
      const callKey = String(id !== undefined && id !== null ? id : '');
      const finish = (body) => {
        if (settled) return;
        settled = true;
        clearInterval(keep);
        if (callKey) inFlightCalls.delete(callKey);
        try { res.write(`data: ${JSON.stringify(body)}\n\n`); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearInterval(keep);
        if (callKey) inFlightCalls.delete(callKey);
        if (typeof onCancel === 'function') { try { onCancel(); } catch { /* ignore */ } }
        try { res.end(); } catch { /* ignore */ }
      };
      if (callKey) inFlightCalls.set(callKey, abort);
      res.on('close', abort);
      Promise.resolve()
        .then(() => callTool({ name: toolName, args, toolCallId: `mcp-${id}`, url, registerCancel: (fn) => { onCancel = fn; } }))
        .then((result) => finish({ jsonrpc: '2.0', id, result: { content: (result && result.content) || [], isError: Boolean(result && result.isError) } }))
        .catch((error) => finish({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `工具执行失败：${error && error.message}` }], isError: true } }));
      return;
    }
    reply(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
  }

  return {
    server,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const addr = server.address();
      return { url: `http://${host}:${addr.port}/mcp`, port: addr.port };
    },
    close() { try { server.close(); } catch { /* ignore */ } },
  };
}

module.exports = { createMcpServer, PROTOCOL_VERSION };
