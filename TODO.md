# 待办（不属于基础网关，属于另外的插件/工程）

记录在这里，刻意不在 1.0.0 里做。

## 1. 额度显示（5 小时 / 每周窗口）

- 现状：ACP 的 `initialize` / `session/new` 里没有额度窗口，`usage_update` 只给上下文占用。
- 可行路径：Antigravity CLI（`agy -p /usage`）能拿到窗口数据，但本机只装了 server 版
  `agy_acp_server.exe` + `localharness_external.exe`，没有 `agy` CLI。
- 需要：先确认 CLI 可用、并能复用同一份登录（`~/.gemini/antigravity-acp/`）。
- 工作量属于「新插件」：常驻查询、缓存、面板徽章、失败降级。

## 2. 让工具在客户端执行（MCP 反向隧道）

- 参考：DSH 插件的做法是 agent 通过反向隧道调客户端 MCP，工具在本机执行、结果回填。
- 现状：PI-Desktop 不给插件这种通道；网关只能「放行/拒绝」agent 自己的工具。
- 要做等于：自建 MCP server + 生命周期管理 + 与宿主工具权限打通，是独立插件量级。
- 收益：工具执行可控、可审计；代价：权限模型要重新设计。

## 3. `tool_call` 进度可视化

- 现状：只写日志（`工具调用：Run search_web?`），响应体里不带。
- 原因：OpenAI chat/responses 没有「agent 内部工具进度」的标准字段；塞进 `tool_calls` 会让宿主
  以为要它执行工具。
- 需要：宿主支持 ACP 事件或自定义事件流后再做。

## 4. 其他小项（有空再说）

- 思考内容：运行时 1.3.0 不下发 `agent_thought_chunk`，已试过三种 `_meta` 形状；等上游。
- `session/load` 的完整参数（`cwd` / `mcpServers`）确认后可做跨重启会话恢复。
- 模型能力提示：`/v1/models` 已声明 `modalities` / `capabilities`，但 PI-Desktop 目前不读；
  若宿主以后支持，可自动完成图文/PDF 能力协商。
