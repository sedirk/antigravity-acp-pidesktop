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
const fs = require('node:fs');
const path = require('node:path');

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
function isAnchoredEditSchema(schema) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : null;
  return Boolean(props && props.tag && props.ops && (props.path || props.file_path));
}

function projectAnchoredEditSchema(schema) {
  const rawProps = schema.properties || {};
  const nextProps = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (k === 'old_string' || k === 'new_string' || k === 'file_path') continue;
    if (v && typeof v === 'object' && typeof v.description === 'string' && /old_string|new_string/i.test(v.description)) {
      nextProps[k] = {
        ...v,
        description: v.description.replace(/\s*\(?unless\s+legacy\s+old_string\/new_string\s+is\s+used\)?/gi, '').trim(),
      };
    } else {
      nextProps[k] = v;
    }
  }
  if (!nextProps.path && rawProps.file_path) {
    nextProps.path = rawProps.file_path;
  }
  const existingReq = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const mergedReq = [...new Set(['path', 'tag', 'ops', ...existingReq.filter((k) => nextProps[k] !== undefined)])];
  return {
    ...schema,
    type: 'object',
    properties: nextProps,
    required: mergedReq,
  };
}

/** OpenAI tools 定义 → MCP 工具目录（支持特殊字符名称转义、行锚点 Edit 模式净化与双向映射）。 */
function projectTools(openaiTools) {
  const out = [];
  const seen = new Set();
  for (const tool of Array.isArray(openaiTools) ? openaiTools : []) {
    const fn = tool && (tool.function || tool);
    const rawName = String((fn && fn.name) || '');
    if (!rawName) continue;
    const name = sanitizeToolName(rawName);
    if (!name || seen.has(name)) continue;
    const rawSchema = (fn && fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} };
    const inputSchema = (name === 'Edit' && isAnchoredEditSchema(rawSchema))
      ? projectAnchoredEditSchema(rawSchema)
      : rawSchema;
    seen.add(name);
    const entry = {
      name,
      rawName,
      description: String((fn && fn.description) || '').slice(0, 4000),
      inputSchema,
    };
    Object.defineProperty(entry, 'rawSchema', { value: rawSchema, enumerable: false });
    out.push(entry);
  }
  return out;
}

/** 从一条 OpenAI 消息里取出工具结果文本。 */
const SAFE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const MAX_TOOL_IMAGE_BYTES = 20 * 1024 * 1024;
const READ_IMAGE_NOTICE_RE = /Image file\s+(.+?)\s+\((\d+)\s+bytes,\s*(image\/[a-z0-9.+-]+)\);\s*the image is attached to this result\./i;

function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6) {
    const hdr6 = buf.subarray(0, 6).toString('ascii');
    if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return '';
}

/** 从一条 OpenAI / Responses 消息里取出工具结果文本。 */
function toolResultText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

function isPathInsideAllowedRoots(candidatePath, allowedRoots) {
  if (!candidatePath || !Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;
  let targetReal;
  try {
    targetReal = fs.realpathSync(path.resolve(candidatePath));
  } catch {
    return false;
  }
  for (const root of allowedRoots) {
    if (!root || typeof root !== 'string') continue;
    let rootReal;
    try {
      rootReal = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    const rel = path.relative(rootReal, targetReal);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

function extractReadNoticeImageBlock(text, { allowedRoots = [], toolCall = null, cwd = '', onLocalImageFallback = null } = {}) {
  if (typeof text !== 'string' || !text || !Array.isArray(allowedRoots) || allowedRoots.length === 0) return null;
  if (!toolCall || typeof toolCall !== 'object') return null;
  const callName = String(toolCall.rawName || toolCall.name || '').trim();
  if (!/^(?:[a-z0-9_.-]+[_/:])?read$/i.test(callName)) return null;
  const callArgs = (toolCall.args && typeof toolCall.args === 'object') ? toolCall.args : {};
  const requestedPath = String(callArgs.path || callArgs.file_path || '').trim();
  if (!requestedPath) return null;
  const baseDir = cwd ? path.resolve(cwd) : process.cwd();
  let requestedReal;
  try {
    const resolvedReq = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(baseDir, requestedPath);
    requestedReal = fs.realpathSync(resolvedReq);
  } catch {
    return null;
  }
  if (!isPathInsideAllowedRoots(requestedReal, allowedRoots)) return null;

  const candidates = [text];
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.content === 'string') candidates.unshift(parsed.content);
    } catch { /* ignore */ }
  }
  for (const sample of candidates) {
    const m = READ_IMAGE_NOTICE_RE.exec(sample);
    if (!m) continue;
    const rawFilePath = String(m[1] || '').trim().replace(/^["']|["']$/g, '');
    const expectedBytes = Number(m[2] || 0);
    const rawMime = String(m[3] || '').toLowerCase();
    const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    if (!rawFilePath || !SAFE_IMAGE_MIMES.has(mimeType)) continue;
    let noticeReal;
    try {
      const resolvedNotice = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(baseDir, rawFilePath);
      noticeReal = fs.realpathSync(resolvedNotice);
    } catch {
      continue;
    }
    if (noticeReal !== requestedReal) continue;
    try {
      const st = fs.statSync(requestedReal);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_TOOL_IMAGE_BYTES) continue;
      if (Number.isFinite(expectedBytes) && expectedBytes > 0 && st.size !== expectedBytes) continue;
      const fileBuf = fs.readFileSync(requestedReal);
      const sniffedMime = detectImageMime(fileBuf);
      if (!sniffedMime || sniffedMime !== mimeType) continue;
      const data = fileBuf.toString('base64');
      if (!data) continue;
      if (typeof onLocalImageFallback === 'function') {
        try { onLocalImageFallback({ path: requestedReal, mimeType: sniffedMime, bytes: st.size }); } catch { /* ignore */ }
      }
      return { type: 'image', mimeType: sniffedMime, data };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 组装 MCP CallToolResult.content 多模态内容块：
 * 1) 保留文本结果块；
 * 2) 将宿主随工具结果回传的 data:image/...;base64,... 转为标准 MCP `{ type: 'image', mimeType, data }`；
 * 3) 当宿主子代理模型配置漏勾视觉能力导致图片被剥离、仅剩 Read 的 `Image file <path> ...` 占位文本时，
 *    在受控工作区/粘贴缓存白名单内安全补读本地图片并回传给底层多模态运行时。
 */
function buildToolResultContent(message, { resultText, allowedRoots = [], toolCall = null, cwd = '', onLocalImageFallback = null } = {}) {
  const finalText = typeof resultText === 'string' ? resultText : toolResultText(message);
  const blocks = [{ type: 'text', text: finalText }];
  const imageUrls = [];
  if (message && Array.isArray(message.images)) {
    for (const u of message.images) {
      if (typeof u === 'string' && u) imageUrls.push(u);
    }
  }
  if (imageUrls.length === 0 && message && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url') {
        const v = part.image_url;
        const u = typeof v === 'string' ? v : (v && v.url) || '';
        if (u) imageUrls.push(u);
      } else if (part.type === 'input_image') {
        const u = part.image_url || part.url || '';
        if (u) imageUrls.push(u);
      }
    }
  }
  let attachedImages = 0;
  for (const url of imageUrls) {
    const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url);
    if (!dataMatch) continue;
    const rawMime = dataMatch[1].toLowerCase();
    const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    const data = dataMatch[2].replace(/\s+/g, '');
    if (!data) continue;
    blocks.push({ type: 'image', mimeType, data });
    attachedImages += 1;
  }
  if (attachedImages === 0) {
    const fallbackBlock = extractReadNoticeImageBlock(finalText, {
      allowedRoots,
      toolCall,
      cwd,
      onLocalImageFallback,
    });
    if (fallbackBlock) blocks.push(fallbackBlock);
  }
  return blocks;
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

function isValidPutLocator(loc) {
  const rangeMatch = /^(\d+)\.=(\d+)$/.exec(loc);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return start >= 1 && end >= start;
  }
  return /^(?:<[1-9]\d*|>[1-9]\d*|>\$)$/.test(loc);
}

function isValidCutLocator(loc) {
  const rangeMatch = /^(\d+)\.=(\d+)$/.exec(loc);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return start >= 1 && end >= start;
  }
  return false;
}

/**
 * 网关侧工具参数预检与无损归一：
 * 在将工具调用挂起交给宿主前拦截明显的契约违例（如 Edit 误传 old_string/new_string、缺 tag/ops、PUT 漏冒号或正文漏 + 前缀，
 * 或 Task 误传 subagent_type/prompt），直接在 MCP 层毫秒级返回纠错提示，避免消耗宿主 3 次失败即熔断回合的预算（MUTATION_RETRY_BUDGET_EXHAUSTED）。
 */
function validateBridgedToolCall(declared, rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? { ...rawArgs } : {};
  if (!declared || typeof declared !== 'object') return { ok: true, args };
  const checkSchema = declared.rawSchema || declared.inputSchema;

  if (declared.name === 'Edit' && isAnchoredEditSchema(checkSchema)) {
    if ((typeof args.path !== 'string' || !args.path.trim()) && typeof args.file_path === 'string' && args.file_path.trim()) {
      args.path = args.file_path.trim();
    }
    if (args.file_path !== undefined) delete args.file_path;

    if (args.old_string === null) delete args.old_string;
    if (args.new_string === null) delete args.new_string;
    if (args.old_string !== undefined || args.new_string !== undefined) {
      return {
        ok: false,
        message: 'INVALID_ARGUMENT（网关预检拦截，未消耗宿主重试预算）：pi-bridge_Edit 严禁传入 old_string / new_string。请先用 pi-bridge_Read 或 pi-bridge_Grep 获取目标文件最新的 4 位十六进制 tag，再传入 { path, tag, ops }（如 ops: "PUT 10.=12:\\n+新内容"，单行替换写 "PUT 10.=10:\\n+新内容"）。',
      };
    }
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return {
        ok: false,
        message: 'INVALID_ARGUMENT（网关预检拦截，未消耗宿主重试预算）：pi-bridge_Edit 缺少必填字符串参数 path。示例：{ "path": "src/index.js", "tag": "FB2A", "ops": "PUT 10.=10:\\n+新内容" }。',
      };
    }
    args.path = args.path.trim();

    const rawTag = typeof args.tag === 'string' ? args.tag.trim() : '';
    if (!/^[0-9a-fA-F]{4}$/.test(rawTag)) {
      return {
        ok: false,
        message: 'EDIT_TAG_REQUIRED（网关预检拦截，未消耗宿主重试预算）：pi-bridge_Edit 的 tag 必须是最近一次 Read/Grep/Write/Edit 返回的 4 位十六进制锚点（如 "FB2A"），请先读取目标文件获取最新 tag。',
      };
    }
    args.tag = rawTag.toUpperCase();

    if (typeof args.ops !== 'string' || !args.ops.trim()) {
      return {
        ok: false,
        message: 'INVALID_ARGUMENT（网关预检拦截，未消耗宿主重试预算）：pi-bridge_Edit 缺少必填字符串参数 ops。支持：PUT N.=M:（替换行，单行写 N.=N）、PUT <N:（行前插入）、PUT >N:（行后插入）、PUT >$:（末尾追加）、CUT N.=M（删除行）；带正文行的 PUT 头部末尾冒号 `:` 与每行 `+` 前缀缺一不可。',
      };
    }

    const rawLines = args.ops.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    let inPutBody = false;
    let bodyCount = 0;
    let lastPutHdr = '';
    for (let i = 0; i < rawLines.length; i += 1) {
      const line = rawLines[i];
      if (line.startsWith('+')) {
        if (!inPutBody) {
          return {
            ok: false,
            message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行以 \`+\` 开头，但前面没有以冒号结尾的 \`PUT ...:\` 指令头（PUT 带正文行时头部末尾冒号 \`:\` 不可省略，且 CUT/REM/MV 不带正文行）。`,
          };
        }
        bodyCount += 1;
        continue;
      }
      if (inPutBody && bodyCount === 0) {
        return {
          ok: false,
          message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：指令头 \`${lastPutHdr}\` 以冒号结尾，但后续替换正文行未加 \`+\` 前缀或为空（每一行新内容都必须以 \`+\` 开头；删除行请用 \`CUT N.=M\`）。`,
        };
      }
      inPutBody = false;
      bodyCount = 0;
      const hdr = line.trim();
      if (!hdr) {
        return {
          ok: false,
          message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行为空操作头（若要在 PUT 正文中写入空行，该行也必须写成单独的 \`+\`）。`,
        };
      }
      const opMatch = /^(PUT|CUT|REM|MV)(?:\s+(.*))?$/.exec(hdr);
      if (!opMatch) {
        return {
          ok: false,
          message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 \`${hdr.slice(0, 48)}\` 非法；仅支持 PUT / CUT / REM / MV 指令头或 \`+\` 开头的正文行（严禁写 unified diff \`@@\`/\`-\` 行或 AFTER/BEFORE/DEL）。`,
        };
      }
      const op = opMatch[1];
      const rest = String(opMatch[2] || '').trim();
      if (op === 'PUT') {
        if (!rest) {
          return { ok: false, message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 PUT 缺少定位符（示例：\`PUT 10.=12:\`）。` };
        }
        if (rest.endsWith(':')) {
          let loc = rest.slice(0, -1).trim();
          if (/^[1-9]\d*$/.test(loc)) loc = `${loc}.=${loc}`;
          if (loc.endsWith('*')) {
            return {
              ok: false,
              message: `EDIT_BLOCK_UNRESOLVED（网关预检拦截，未消耗宿主重试预算）：当前宿主版本不支持块定位符 \`${loc}\`（\`*\`），请改用明确行号范围 \`PUT N.=M:\`（单行写 \`PUT N.=N:\`）。`,
            };
          }
          if (!isValidPutLocator(loc)) {
            return {
              ok: false,
              message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 PUT 定位符 \`${loc}\` 非法；合法定位符为 \`N.=M\`（1<=N<=M，单行写 \`N.=N\`）、\`<N\`、\`>N\` 或 \`>$\`。`,
            };
          }
          rawLines[i] = `PUT ${loc}:`;
          inPutBody = true;
          bodyCount = 0;
          lastPutHdr = rawLines[i];
        } else {
          const regMatch = /^(\S+)\s+(@[A-Za-z0-9_-]+)$/.exec(rest);
          if (!regMatch) {
            return {
              ok: false,
              message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 \`${hdr.slice(0, 48)}\` 缺少末尾冒号 \`:\`（带 \`+\` 正文行的 PUT 必须写成 \`PUT N.=M:\`）。`,
            };
          }
          let loc = regMatch[1];
          if (/^[1-9]\d*$/.test(loc)) loc = `${loc}.=${loc}`;
          if (loc.endsWith('*')) {
            return {
              ok: false,
              message: `EDIT_BLOCK_UNRESOLVED（网关预检拦截，未消耗宿主重试预算）：当前宿主版本不支持块定位符 \`${loc}\`（\`*\`），请改用明确行号范围 \`PUT N.=M\`。`,
            };
          }
          if (!isValidPutLocator(loc)) {
            return {
              ok: false,
              message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 PUT 定位符 \`${loc}\` 非法；合法定位符为 \`N.=M\`、\`<N\`、\`>N\` 或 \`>$\`。`,
            };
          }
          rawLines[i] = `PUT ${loc} ${regMatch[2]}`;
        }
      } else if (op === 'CUT') {
        if (!rest || rest.endsWith(':')) {
          return {
            ok: false,
            message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 \`${hdr.slice(0, 48)}\` 格式错误；CUT 需要行范围且不带冒号或正文（示例：\`CUT 10.=12\`）。`,
          };
        }
        const cutParts = /^(\S+)(?:\s+(@[A-Za-z0-9_-]+))?$/.exec(rest);
        if (!cutParts) {
          return {
            ok: false,
            message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 CUT 参数 \`${rest.slice(0, 48)}\` 非法（示例：\`CUT 10.=12\`）。`,
          };
        }
        let loc = cutParts[1];
        if (/^[1-9]\d*$/.test(loc)) loc = `${loc}.=${loc}`;
        if (loc.endsWith('*')) {
          return {
            ok: false,
            message: `EDIT_BLOCK_UNRESOLVED（网关预检拦截，未消耗宿主重试预算）：当前宿主版本不支持块定位符 \`${loc}\`（\`*\`），请改用明确行号范围 \`CUT N.=M\`（单行写 \`CUT N.=N\`）。`,
          };
        }
        if (!isValidCutLocator(loc)) {
          return {
            ok: false,
            message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 CUT 定位符 \`${loc}\` 非法；合法定位符为 \`N.=M\`（1<=N<=M，单行写 \`N.=N\`）。`,
          };
        }
        rawLines[i] = cutParts[2] ? `CUT ${loc} ${cutParts[2]}` : `CUT ${loc}`;
      } else if (op === 'REM') {
        if (rest) {
          return { ok: false, message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 REM 不接受任何参数或冒号。` };
        }
      } else if (op === 'MV') {
        if (!rest || rest.endsWith(':')) {
          return { ok: false, message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：ops 第 ${i + 1} 行 MV 需要目标路径且不带冒号或正文。` };
        }
      }
    }
    if (inPutBody && bodyCount === 0) {
      return {
        ok: false,
        message: `EDIT_PARSE_FAILED（网关预检拦截，未消耗宿主重试预算）：指令头 \`${lastPutHdr}\` 以冒号结尾，但后面没有任何 \`+\` 开头的正文行（删除行请改用 \`CUT N.=M\`）。`,
      };
    }
    args.ops = rawLines.join('\n');
    return { ok: true, args };
  }

  if (declared.name === 'Task' && checkSchema && Array.isArray(checkSchema.required)) {
    const reqSet = new Set(checkSchema.required.map(String));
    if (reqSet.has('agent') && reqSet.has('task')) {
      if (args.subagent_type === null) delete args.subagent_type;
      if (args.prompt === null) delete args.prompt;
      if (args.subagent_type !== undefined || args.prompt !== undefined) {
        return {
          ok: false,
          message: 'INVALID_ARGUMENT（网关预检拦截）：pi-bridge_Task 严禁传 subagent_type 或 prompt，必须传入字符串参数 { agent, task }。',
        };
      }
      if (typeof args.agent !== 'string' || !args.agent.trim() || typeof args.task !== 'string' || !args.task.trim()) {
        return {
          ok: false,
          message: 'INVALID_ARGUMENT（网关预检拦截）：pi-bridge_Task 必填非空字符串参数 agent 与 task。',
        };
      }
    }
  }

  return { ok: true, args };
}

function summarizeToolSignatures(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const sorted = [...tools].sort((a, b) => String((a && a.name) || '').localeCompare(String((b && b.name) || '')));
  const sigs = [];
  const notes = [];
  for (const t of sorted) {
    if (!t || !t.name) continue;
    const rawSchema = t.rawSchema || t.inputSchema;
    const schema = (t.name === 'Edit' && isAnchoredEditSchema(rawSchema))
      ? projectAnchoredEditSchema(rawSchema)
      : t.inputSchema;
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
    if (t.name === 'Edit' && isAnchoredEditSchema(rawSchema)) {
      notes.push('pi-bridge_Edit 必填 path、tag（最近 Read/Grep/Write/Edit 返回的 4 位十六进制锚点）、ops（行锚点指令：替换 `PUT 10.=12:\\n+新内容`、单行 `PUT 10.=10:\\n+新内容`、行前插入 `PUT <10:\\n+新内容`、行后插入 `PUT >10:\\n+新内容`、末尾追加 `PUT >$:\\n+新内容`、删除 `CUT 10.=12`；PUT 带正文行时末尾冒号与每行 `+` 前缀缺一不可，严禁传 old_string/new_string）');
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

module.exports = {
  projectTools,
  toolResultText,
  buildToolResultContent,
  createBridgeState,
  toToolCalls,
  matchToolResult,
  summarizeToolSignatures,
  validateBridgedToolCall,
  isAnchoredEditSchema,
  NAME_OK,
  sanitizeToolName,
};
