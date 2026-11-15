'use strict';

/**
 * 工具回交（把 PI 的工具交给 ACP 运行时调用）。
 *
 * 与“套皮”的区别：这里的工具**不由网关执行**。运行时调用 → 网关挂起 →
 * 以 OpenAI tool_calls 结束这一轮 → 宿主用**自己的**工具循环执行（原生卡片、权限、hooks）→
 * 结果回到下一轮请求 → 网关把结果交回给仍在等待的 MCP 调用。
 *
 * 设计参考 @estebanforge/pi-antigravity-bridge 与 pi-agy-acp（MIT）：
 * 名称原样透传（宿主按名字执行）、只挂起不执行、结果一次性回填。
 */

const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;

const NAMESPACED_NAME = /^[A-Za-z0-9_-]+[/:.][A-Za-z0-9_/:.-]+$/;

/** 将合法命名空间（如 pi-desktop/visualize 或 ns:tool）合规转义为符合 MCP 标准的名称；其余非法名依然过滤。 */
function sanitizeToolName(rawName) {
  const str = String(rawName || '').trim();
  if (NAME_OK.test(str)) return str;
  if (NAMESPACED_NAME.test(str)) {
    const sanitized = str.replace(/[/:.]+/g, '_').slice(0, 64);
    if (NAME_OK.test(sanitized)) return sanitized;
  }
  return '';
}
/** OpenAI tools 定义 → MCP 工具目录（支持特殊字符名称转义与双向映射）。 */
function projectTools(openaiTools) {
  const out = [];
  const seen = new Set();
  for (const tool of Array.isArray(openaiTools) ? openaiTools : []) {
    const fn = tool && (tool.function || tool);
    const rawName = String((fn && fn.name) || '');
    if (!rawName) continue;
    const name = sanitizeToolName(rawName);
    if (!name || seen.has(name)) continue;
    const schema = (fn && fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} };
    seen.add(name);
    out.push({
      name,
      rawName,
      description: String((fn && fn.description) || '').slice(0, 4000),
      inputSchema: schema,
    });
  }
  return out;
}

/** 从一条 OpenAI 消息里取出工具结果文本。 */
function toolResultText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

/**
 * 一次“挂起中”的桥接轮次。
 * paused=true 表示已经向宿主发出 tool_calls、正在等执行结果。
 */
function createBridgeState() {
  return {
    parked: [],         // Array<{ toolCallId, name, args, resolve }>
    paused: false,
    sessionId: null,
    tools: [],
  };
}

/** 把运行时请求的工具参数转成 OpenAI tool_calls 负载（支持单个或数组批量）。 */
function toToolCalls(parked) {
  const list = Array.isArray(parked) ? parked : (parked ? [parked] : []);
  return list.map((call, index) => ({
    index,
    id: call.toolCallId,
    type: 'function',
    function: { name: call.rawName || call.name, arguments: JSON.stringify(call.args || {}) },
  }));
}

/**
 * 找到“属于挂起调用的工具结果”。宿主下一轮会把 role=tool 的消息放在 messages 里。
 */
function matchToolResult(messages, toolCallId) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'tool') continue;
    const id = message.tool_call_id || message.toolCallId || '';
    if (String(id) !== String(toolCallId)) continue;
    return message;
  }
  return null;
}

function summarizeToolSignatures(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const sorted = [...tools].sort((a, b) => String((a && a.name) || '').localeCompare(String((b && b.name) || '')));
  const sigs = [];
  const notes = [];
  for (const t of sorted) {
    if (!t || !t.name) continue;
    const schema = t.inputSchema;
    if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') continue;
    const propNames = Object.keys(schema.properties).sort();
    if (propNames.length === 0) continue;
    const reqSet = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const reqList = propNames.filter((k) => reqSet.has(k));
    const optList = propNames.filter((k) => !reqSet.has(k));
    const shown = [
      ...reqList,
      ...optList.slice(0, Math.max(0, 5 - reqList.length)).map((k) => `${k}?`),
    ];
    if (optList.length > Math.max(0, 5 - reqList.length)) shown.push('...');
    sigs.push(`pi-bridge_${t.name}(${shown.join(', ')})`);
    if (t.name === 'Edit' && schema.properties.ops && schema.properties.tag) {
      notes.push('pi-bridge_Edit 必填 path、tag（最近 Read/Grep/Write/Edit 返回的 4 位十六进制锚点）、ops（行锚点指令，如 `PUT 10.=12:\\n+新内容`，PUT 带正文行时末尾冒号与每行 `+` 前缀缺一不可，严禁传 old_string/new_string）');
    } else if (t.name === 'Task' && reqSet.has('agent') && reqSet.has('task')) {
      notes.push('pi-bridge_Task 必填 agent 与 task（禁止传 subagent_type/prompt）');
    }
  }
  if (sigs.length === 0 && notes.length === 0) return '';
  const lines = [];
  if (sigs.length > 0) lines.push(`参数签名速查：${sigs.join('；')}。`);
  for (const n of notes) lines.push(`契约提醒：${n}。`);
  return lines.join('\n');
}

module.exports = { projectTools, toolResultText, createBridgeState, toToolCalls, matchToolResult, summarizeToolSignatures, NAME_OK, sanitizeToolName };
