'use strict';
const path = require('node:path');
const { createGateway } = require('D:/tools/antigravity-acp/lib/server.js');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let serial = 0;
const calls = [];
let mcpUrl = null;
const acp = {
  policyBySession: new Map(),
  start: async () => {}, discover: async () => {},
  cwdFor: async () => process.env.PI_SCRATCH_DIR,
  resolveModel: (x) => x, status: () => ({ ready: true }),
  notify: (...a) => calls.push(a),
  request: async (method, params) => {
    if (method === 'session/new') { mcpUrl = (params.mcpServers || [])[0]?.url || null; log('session/new mcp=', mcpUrl); return { sessionId: 's' + (++serial) }; }
    if (method === 'session/prompt') {
      acp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resp narration' } } } });
      log('prompt -> MCP tools/call');
      const r = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo resp' } } }) });
      const body = await r.text();
      log('MCP 回填:', body.replace(/\s+/g, ' ').slice(0, 120));
      acp.onNotification({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resp done' } } } });
      return { stopReason: 'end_turn' };
    }
    return {};
  },
};
const cfg = { bind: '127.0.0.1', port: 0, defaultModel: 'test', toolPolicy: 'all', maxSessions: 20, promptTimeoutMs: 20000, promptIdleTimeoutMs: 20000, bridgeTools: true, source: path.join(process.env.PI_SCRATCH_DIR, 'repro2', 'config.json') };
const gw = createGateway({ acp, limiter: { run: (f) => f(), stats: () => ({}) }, getConfig: () => cfg, log: (m) => log('GW', m) });
setTimeout(() => { log('WATCHDOG'); process.exit(2); }, 30000).unref();

const tools = [{ type: 'function', name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
const parse = (t) => t.split('\n').filter((x) => x.startsWith('data: ') && !x.includes('[DONE]')).map((x) => JSON.parse(x.slice(6)))
  .map((e) => e.type ? e : { type: 'chunk', ...e });

(async () => {
  const net = require('node:net');
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  await gw.listen([port]);
  const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', stream: true, input: 'run echo', tools, prompt_cache_key: 'resp-repro' }),
  });
  const ev1 = parse(await first.text());
  log('第一轮事件:', ev1.map((e) => e.type).join(','));
  const fc = ev1.find((e) => e.type === 'response.output_item.done' && e.item && e.item.type === 'function_call');
  const txt1 = ev1.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  log('第一轮正文:', JSON.stringify(txt1));
  if (!txt1.includes('resp narration')) process.exit(6);
  log('function_call:', fc ? fc.item.name + ' ' + fc.item.call_id : 'NONE');
  if (!fc) process.exit(3);
  const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test', stream: true, tools, prompt_cache_key: 'resp-repro',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run echo' }] },
        { type: 'function_call', call_id: fc.item.call_id, name: fc.item.name, arguments: fc.item.arguments },
        { type: 'function_call_output', call_id: fc.item.call_id, output: 'echo resp output' },
      ],
    }),
  });
  const ev2 = parse(await second.text());
  const text = ev2.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  log('第二轮文本:', JSON.stringify(text.slice(0, 120)));
  gw.close();
  process.exit(text.includes('resp done') ? 0 : 4);
})().catch((e) => { log('FATAL', e.message); process.exit(5); });
