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
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('bad json'); return; }
      handle(payload, res, req.url);
    });
  });

  function reply(res, body) {
    const text = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }).end(text);
  }

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
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      res.writeHead(202).end();
      return;
    }
    if (method === 'tools/list') {
      let tools = [];
      try { tools = listTools() || []; } catch (error) { log(`tools/list 失败：${error && error.message}`); }
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
      const finish = (body) => {
        clearInterval(keep);
        try { res.write(`data: ${JSON.stringify(body)}\n\n`); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
      };
      const abort = () => { clearInterval(keep); try { res.end(); } catch { /* ignore */ } };
      res.on('close', abort);
      Promise.resolve()
        .then(() => callTool({ name: toolName, args, toolCallId: `mcp-${id}`, url }))
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
