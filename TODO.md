# 待办 / 结论清单

只记「还没做」和「明确不做」。做完的从这里删掉，避免清单越写越长。

## 明确不做：额度显示（5 小时 / 每周窗口）

2026-11 复核结论：没有「官方 + 无风险」的数据来源，而估算出来的额度只会误导，所以不做。

证据（都可复现）：

- ACP `initialize` 只回 `agentCapabilities { loadSession, promptCapabilities, mcpCapabilities, sessionCapabilities, auth }`；
  `session/new` 只回 `models` 与 `configOptions`（model / mode）；`session/update` 里的 `usage_update` 只有 `{used, size}`，
  是上下文占用，不是账号额度。
- `available_commands_update` 只有 `plan` 和 `logout`；把 `/usage` 当 prompt 发进去，模型会当普通任务处理
  （实测它开始 `Get-ChildItem` 翻目录）。
- 官方下载站只有 server 版：`dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip`（200），
  `agy-cli-*` / `agy-*` / `antigravity-cli-*` 全是 404；`agy_acp_server.exe --help` 不打印任何东西（只认 stdio ACP）。
- 真正的窗口数据只存在于 `v1internal:retrieveUserQuota` / `retrieveUserQuotaSummary`
  （`localharness_external.exe` 里带这组 protobuf schema），等于拿用户 OAuth 令牌去调 Google 私有 API —— 明确不做。
- 也没有本地缓存可用：`~/.gemini/antigravity/antigravity_state.pbtxt` 只有 onboarding / 迁移状态。

如果哪天官方 ACP 给出额度字段，或放出发行版 `agy` CLI，再回来做。

## 缓存前缀：逐条审计结论（2.1.6）

服务端 prompt cache 是「按模型 + 前缀」的，我们看不到命中数（见上），只能保证**不去主动毁前缀**。
把可能触发重算的入口逐个核过，结论：

| 操作 | 会不会毁前缀 | 依据 / 处理 |
| --- | --- | --- |
| 同一会话续聊 | 不会 | 续会话只发本轮增量（`lastUserText`），历史留在运行时那边 |
| 空闲回收（`session/close`） | 不会（历史还在） | 实测 close → `resume`/`load` 都答出了暗号；close 只是放掉 worker |
| 网关/运行时重启 | 不会（有足迹时） | 足迹存 `sessions.json`，先 `session/load`；2.1.6 起映射丢了也只丢映射、留足迹 |
| 会话数超上限 | 不会（同上） | 只 `session/close` + 丢映射，足迹保留 |
| 换模型 / 换档位 | 会，且不可控 | Google 按模型隔离缓存，`set_model` 只能省掉重放，省不掉 miss |
| 桥接开关/端口变化 | 不会（2.1.6 起） | 先 close 再 `session/load` 带新 `mcpServers` 重挂载，失败才重建 |
| 宿主压缩上下文 | 会，且不可控 | 历史被改写，前缀整段变；网关无法阻止 |
| 缓存 TTL 到期 | 会，且不可控 | 停一会儿就过期，与网关无关 |
| 超时/放弃后重建 | 会（少见的坏路径） | 会话卡死只能 `session/close` 止损；足迹仍在，能接回就接回 |

一句话：网关唯一能控的杠杆是「别重建、别重放」，其余都在 Google 侧。

## 等上游（受阻于运行时 1.3.0）

- 思考内容：运行时不发 `agent_thought_chunk`（`gateway.log` 里 0 条），已试过三种 `_meta` 形状。
- 工具之间没有 `agent_message_chunk`：正文断档只能靠可编辑的桥接提示层缓解，不能保证模型照做。
- Responses 通道只在 `response.completed/incomplete` 上报 usage，因此没有实时 tokens/s（chat 通道才有逐块 usage）。
- **缓存命中数（宿主里「缓存读取」那一栏）永远是 0，不是 bug**：ACP 的 `usage_update` 只有 `{used, size}`，
  网关的 usage 里也没有 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`，
  宿主读不到就显示 0。已核过运行时的 `brain/**/transcript_full.jsonl`：没有 `usageMetadata` /
  `promptTokenCount` / `cachedContentTokenCount`，所以连「私下去读运行时文件」这条路也走不通。
  与升级插件、重启软件、暂停时长都无关（否则应该是偶发 0，而不是恒为 0）。
  附带事实：`prompt_tokens` 取运行时真实的 `context_used`，`completion_tokens` 是文本长度估算，
  所以宿主里的「输入/输出/合计」本身也是估算值，分项相加会对不上——只能当粗略参考。

- 模型能力提示：`/v1/models` 已声明 `modalities` / `capabilities`，PI-Desktop 目前不读；
  宿主以后支持的话，可自动完成图文 / PDF 能力协商。

## 已交付（留档，别再当待办）

- MCP 反向隧道（工具回交）：2.0.0 起为所有通道默认开启，关掉开关才走「运行时自带工具」。
- `tool_call` 进度可视化：以「思考」一行一个工具的形式随流下发（1.5.13 / 2.0.x）。
- 跨重启会话恢复：`session/load`（2.1.0），失败自动回落新建会话。
