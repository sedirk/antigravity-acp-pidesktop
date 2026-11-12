# 待办 / 结论清单

只记「还没做」和「明确不做」。做完的从这里删掉，避免清单越写越长。

## 待办事项：代码优化与健壮性提升（按优先级排序）

> 遵循核心原则：不碰 Google 凭据、默认并发不限制（`concurrency: 0`）、权限默认放行（`toolPolicy: 'all'`）、工具回交优先宿主原生卡片。

### 🔴 第一优先级：会话核心稳定性与并发防护
1. [x] **工具桥多会话目录隔离与精准路由**（`lib/mcp.js`, `lib/server.js`）：`tools/list` 传递 URL 并在服务端按 `?k=` 解析会话键，彻底杜绝多个不同配置会话并发时的工具列表串扰。（✅ 已完成，含回归测试）
2. [x] **单连接串行锁与限流队列解耦**（`lib/server.js`）：保持默认 `concurrency: 0`（不限并发）；将底层 ACP 单连接串行排队下沉至执行阶段，外层由限流器接管队列上限与超时丢弃，防止内存无界挂起。（✅ 已完成，含解耦测试）
3. [x] **模型探测与切换异常分支的会话/Worker 泄露防护**（`lib/core.js`, `lib/server.js`）：`#discoverNow` 与 `applyModel` 增加严格的 `try...finally`，确保任何异常分支均能调用 `session/close` 释放外部 `localharness_external.exe` 进程。（✅ 已完成，含异常闭锁测试）
4. [x] **MCP 协议 `notifications/cancelled` 联动取消挂起**（`lib/mcp.js`, `lib/bridge-turn.js`）：支持客户端主动取消工具时触发 `registerCancel` 提前释放挂起 Promise，避免挂起一直阻塞到超时。（✅ 已完成，含协议测试）

### 🟡 第二优先级：生态兼容性与持久化数据完整性
5. [x] **特殊命名工具的合法转义与双向映射**（`lib/bridge.js`）：对包含 `/`、`.` 或 `:` 的宿主工具名（如 `pi-desktop/visualize`）做合规安全转义与双向映射，避免被 `NAME_OK` 正则静默丢弃。（✅ 已完成，含双向映射测试）
6. [x] **会话足迹 `sessions.json` 原子化落盘**（`lib/session-store.js`）：引入 `.tmp` + rename 的 `writeAtomic` 机制，防止断电或被杀进程时足迹半写导致历史全丢。（✅ 已完成，含落盘测试）
7. [x] **`file://` 本地附件白名单与路径边界检查**（`lib/server.js`）：限制仅允许访问工作区 `cwd`、宿主项目根路径或附件目录，防止越界读取系统任意文件。（✅ 已完成，含越界防御测试）

### 🟢 第三优先级：标准协议互通与交互细节优化
8. [x] **增加 CORS 跨域支持与 `OPTIONS` 预检响应**（`lib/server.js`）：补充 `Access-Control-Allow-Origin: *` 与 `OPTIONS` 快速 204，方便 Web 客户端（OpenWebUI 等）跨域调用本地网关。（✅ 已完成，含跨域与预检测试）
9. [x] **超限请求优雅返回 HTTP 413 替代直接断开 TCP**（`lib/server.js`, `lib/mcp.js`）：超过请求体限制时返回标准的 HTTP 413 JSON 错误后再关闭流，替代强制 `destroy` 造成的 `ECONNRESET`。（✅ 已完成，含 413 异常状态测试）
10. [x] **官方累计上下文占用命中时标明 `estimated: false`**（`lib/server.js`）：取得运行时真实的 `contextUsed` 时将 `estimated` 设为 `false`，提升宿主界面百分比与计费准确度。（✅ 已完成，含上下文估算回归测试）

### ⚪ 第四优先级：管理面板功能增强
11. [x] **配置面板增加会话管理与会话状态可视化**（`renderer/config.html`, `main.js`, `lib/server.js`）：展示当前内存活跃会话列表及绑定状态，提供一键回收闲置会话功能。（✅ 已完成，含会话列表与回收测试）
12. [x] **工具权限策略界面细化说明**（`renderer/config.html`）：细化 `toolPolicy` 各档位放行/拦截的具体工具类型说明。（✅ 已完成，界面文案已细化）

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
