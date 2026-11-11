# Antigravity ACP · PI-Desktop 插件

把 Google 官方的 **Antigravity ACP 运行时**（`agy_acp_server.exe`）包装成 OpenAI 兼容的本地网关，
供 PI-Desktop 作为「自定义端点」使用。

**边界**：只与本机官方二进制用 stdio JSON-RPC 通信；不读取、不转发、不保存任何 Google 凭据
（凭据由那个二进制自己保管在 `~/.gemini/antigravity-acp/`）；不逆向 Google 私有接口。

## 它做什么

- 在本机 `127.0.0.1` 暴露 `POST /v1/chat/completions`、`POST /v1/responses`、`GET /v1/models`
- **虚拟模型**：把 ACP 的 `xxx-low/-medium/-high` 自动合并成 `xxx`，思考档位由请求里的
  `reasoning_effort` 决定（新模型上线只要还带档位后缀就会自动出现，不用改代码）
- **图片输入**（0.4.0 起）：`image_url` / `input_image` 的 `data:` URL 与 `http(s)`
  链接都转成 ACP 的 `image` 内容块随同一条 prompt 发出
- **PDF / 文档输入**（0.5.0 起）：`input_file`、`file`、`document` 三种写法都接；字节先落到会话工作区的
  `.attachments\`（按内容哈希去重、7 天后自动清理），再以 `resource_link`（`file://` URI）发给运行时
- **联网搜索与工具**（0.6.0 起）：agent 自带 `search_web` / `read_url_content` / `run_command` 等，
  由面板「工具权限」按档放行；1.1.0 起新增 `shell` 档
- 给运行时子进程按需注入 `HTTP(S)_PROXY`，不影响系统代理
- **可选并发限制**（默认关闭）：设成 1 即串行，其余请求排队，带排队超时与队满拒绝
- 面板一键下载官方运行时并做 SHA256 校验

## 兼容性

- 宿主：PI-Desktop ≥ 0.9.0（模块入口、`pluginBridge.invoke`、`ui.openPanel`）
- 运行时：官方 `agy_acp_server` 1.3.0（面板下载的就是这一版，SHA256 校验）
- 系统：Windows 10/11；macOS/Linux 需手动放置运行时并填 `bin`
- 协议：ACP 1（`initialize` / `session/new` / `set_model` / `prompt` / `cancel`（通知）/
  `close` / `resume` / `request_permission`），OpenAI 兼容 `/v1/chat/completions` 与 `/v1/responses`

## 版本与后续

- 变更记录见 [CHANGELOG.md](CHANGELOG.md)
- 刻意没做的（额度、客户端执行工具、工具进度可视化）见 [TODO.md](TODO.md)

## 安装与配置

1. 插件页安装后打开命令「Antigravity: 打开配置面板」
2. 点「下载官方运行时」（约 120 MB，走你填的代理；SHA256 会对官方清单校验）
3. 首次使用需登录：在终端跑一次运行时并完成 Google 登录，或先在本机 Antigravity 里登录

   ```powershell
   & "$env:USERPROFILE\.pi-desktop\plugins\data\local.antigravity-acp\runtime\agy_acp_server.exe"
   ```

   登录完成后凭据保存在 `~/.gemini/antigravity-acp/`，插件不会读取它。
4. 在 PI-Desktop「设置 → AI 服务 → 自定义端点」填 `http://127.0.0.1:41910/v1`，
   认证留空，接口格式选 Chat Completions 或 Responses，然后「获取模型列表」

宿主侧还需要注意两点：

- **能不能发图/发 PDF 由宿主决定**：PI-Desktop 只按模型能力决定是否把附件放进请求体，
  图文能力取自它内置的 models.dev 目录，或用模型绑定里的 `supportsImages` / `supportsDocuments` 覆盖。
- 想让它用 `reasoning_effort`，模型行的「思考协议」要选**标准**（自适应发的是 Anthropic 式
  `thinking`/`output_config`，本网关不解析）。

## 配置只有一处

面板写入插件数据目录的 `config.json`，**这是唯一配置来源**；不要手改文件。
旧版本放在插件根目录的 `config.json` 只在首次加载时迁移一次，之后不再读取。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 41910 | 本地网关端口 |
| `proxyMode` | `auto` | `auto` 跟随系统代理 / `manual` 用下面填的地址 / `direct` 直连 |
| `proxy` | 空 | 手动模式的代理地址，如 `http://127.0.0.1:10808` |
| `toolPolicy` | `all` | 工具权限：`all` / `shell` / `agent` / `search` / `none`；**默认不额外拦截**，见「三层权限」 |
| `cancelOnDisconnect` | true | 客户端断开时发 `session/cancel` 通知；取消后 20 秒未结束才杀运行时 |
| `idleSessionMinutes` | 10 | 空闲多久 `session/close` 回收 worker；下次优先 `session/resume` |
| `concurrency` | 0 | 0 = 不限制；1 = 串行；2–8 = 并行上限 |
| `queueTimeoutMs` | 300000 | 排队等待上限 |
| `defaultEffort` | 空 | 请求没带 `reasoning_effort` 时使用的档位（low/medium/high）；空 = 模型默认 medium |
| `virtualModels` | true | 按档位后缀合并模型 |
| `exposeVariantModels` | false | 是否同时列出带档位后缀的显式模型 |
| `promptTimeoutMs` | 600000 | 单轮回答超时 |
| `bin` | 空 | `agy_acp_server.exe` 路径（面板下载后自动写入） |
| `cwd` | 空 | 留空 = 跟随 PI-Desktop 当前项目目录（建会话时现问，取不到回退用户主目录）；填了就固定用它。它是文件工具的白名单根，不是命令沙箱 |
| `modelCacheMs` | 300000 | 模型列表缓存时长 |

## 参数透传：哪些生效、哪些被运行时忽略

ACP 的 `session/prompt` 只接受内容块，**没有任何采样参数位**；思考档位是编码在模型 ID 后缀里的
（`-low` / `-medium` / `-high`），所以「思考强度」靠换模型实现，而不是传 `thinking` 对象。
下表是实测结论（官方运行时 1.3.0，真实请求验证，不是文档推断）：

| 请求字段 | 结果 | 说明 |
| --- | --- | --- |
| `reasoning_effort` | ✅ 生效 | `low`/`minimal`→`-low`，`high`/`xhigh`/`max`→`-high`，缺省或其它→`-medium`；日志会打印 `chat gemini-3.8-flash → gemini-3.8-flash-low（effort=low）` |
| 模型 ID 带档位后缀 | ✅ 生效 | 例如直接写 `gemini-3.8-flash-high`，按后缀选 |
| `image_url` / `input_image` | ✅ 生效 | `data:` URL 与 `http(s)` 链接都转成 ACP 的 `image` 块（0.4.0 起） |
| `input_file` / `file` / `document`（PDF 等） | ✅ 生效（0.5.0 起） | 落盘到工作区 `.attachments\` 后以 `resource_link` 发出；`file_id` 形式取不到，会在 prompt 里留一句说明 |
| `stream` | ✅ 生效 | SSE 流式 |
| `tools`（**含 `web_search`**） | ⚠️ 部分生效 | 不映射函数调用，但 agent 自带 `search_web` / `read_url_content`，由「工具权限」放行即可联网 |
| `tool_choice`、`parallel_tool_calls` | ❌ 未映射 | 工具由 agent 自己决定何时调用 |
| `temperature`、`top_p`、`top_k`、`max_tokens`、`max_completion_tokens`、`stop`、`seed`、`presence_penalty`、`frequency_penalty`、`logprobs`、`top_logprobs`、`logit_bias`、`response_format`、`text.format`、`verbosity` | ❌ 被忽略 | 实测 `max_tokens=8` 仍输出 229 字；运行时既不报错也不生效，属静默丢弃，网关会在日志里打印「运行时忽略 …」 |
| 思考内容（`agent_thought_chunk`） | ⚠️ 通道已接好，但运行时不发 | 实测 carbon/argon/3.8-flash × low/high 四组，思考块都是 0 字：能改档位，读不到思维过程 |
| `usage` | ⚠️ token 估算 + 上下文真实值 | 单次 token 数按「CJK 每字 1 token、其余 4 字符 1 token」估算并标 `estimated: true`；同时透出运行时上报的真实 `context_used` / `context_size` |

`GET /v1/models` 会顺带声明能力：`modalities.input = [text, image]`、`capabilities = [text, image, reasoning]`、
`supports_reasoning_effort = true`、`reasoning_efforts = [low, medium, high]`、`context_length`。
这些字段对标准 OpenAI 客户端无害，但 **PI-Desktop 目前不读它们**：它的模型发现只从服务端的模型行里取
`contextWindow` / `maxTokens`，图文能力一律取自它内置的 models.dev 目录（命中不到就按纯文本处理），
用户可在「设置 → AI 服务 → 该服务 → 模型」里用 `supportsImages` 覆盖。能不能发附件最终由宿主侧决定，
插件这边只保证「宿主发来的附件不丢」。

## 联网搜索与工具权限（0.6.0 起；1.1.0 加 `shell` 档并默认不设防）

ACP 的 agent 自带一套工具：`search_web`、`read_url_content`、`view_file`、`run_command`、`write_to_file`、
`invoke_subagent`、`generate_image`、`schedule` 等。联网能力一直都在，之前用不了是因为网关把 agent 发来的
`session/request_permission` 一律回成 `null`，运行时判成非法响应，工具直接失败
（报错原文：`RequestPermissionResponse · input_value=None`）。

现在网关按面板里的「工具权限」回答权限请求。**默认 `all`：本插件不额外设防**——真正的边界是运行时的
工作区白名单（`cwd`）与宿主自己的审批。想收紧才往下调：

| 策略 | 行为 |
| --- | --- |
| `all`（默认） | 全部放行：读文件、跑命令、写文件都交给运行时 |
| `shell` | 放行只读 + `execute`（`run_command` 等）；仍挡住 `edit`（写文件） |
| `agent` | 只读 + `kind=other`（子代理、后台任务、生图、定时）；挡执行与写文件 |
| `search` | 只放行只读：`search` / `fetch` / `read`（联网搜索、抓网页、读文件） |
| `none` | 全部拒绝，当纯聊天网关用 |

### 请求级调整（0.9.0 起）

除了全局策略，单条请求也能改本轮权限：

- 请求体带 `tool_policy`（自定义字段，`search` / `agent` / `shell` / `all` / `none`）→ 本轮按它执行；
- 宿主带了联网搜索工具声明（`tools` 里有 `web_search` / `web_search_preview`，PI-Desktop 勾「原生联网搜索」时会发）
  → 即使配置是 `none`，本轮也临时放宽到 `search`（只放行只读工具）。

生效时日志会写 `工具权限按请求调整：none（request.tool_policy）` 这类记录。

### 用量记录（0.9.0 起）

每次回答结束会往插件数据目录的 `usage.jsonl` 追加一行（超过 5MB 自动轮转成 `.1`）：

```json
{"at":"2026-11-10T18:49:00.963Z","session":"34d625c2","policy":"search","ms":15034,
 "contextUsed":11247,"contextSize":1048576,"tools":{}}
```

`/health` 与插件命令「显示网关状态」里的 `lastRequest` 就是最近这一行。

## 三层权限：为什么「我在 PI-Desktop 里给了全部权限」还是读不到文件

这条线上有三套互不相干的权限，搞混就会以为「权限被吞了」：

1. **PI-Desktop 的插件权限**（`background.service` / `ui.panel` 等）—— 决定宿主允不允许插件跑服务和开面板，
   **与 agent 能不能读文件、跑命令无关**。
2. **本插件的「工具权限」**（`toolPolicy`）—— 决定 agent 的 `session/request_permission` 怎么回答。
   1.1.0 起默认 `all`，这一层不拦；只有你主动调成 `shell` / `agent` / `search` / `none` 才会拒。
   被拒时运行时的报错是 `denied by pre-tool hook: Denied by user (*)`，很容易被误认为宿主拒绝。
3. **运行时的会话工作区** —— 真正的硬边界：只有会话 `cwd` 与 `~/.gemini` 下的路径可访问，
   越界时 `view_file` 直接报「不在允许访问的工作区目录列表内」。`cwd` 由面板「工作目录」决定：
   **1.2.0 起留空 = 跟随 PI-Desktop 当前项目目录**（每次建会话现问宿主，取不到回退用户主目录）；
   1.1.0 留空是用户主目录；1.0.x 及更早是运行时所在目录——那才是「连 `~/.codex` 都读不到」的原因。
   ⚠️ 只有**文件工具**受它限制：`run_command`（`kind=execute`）走系统权限，实测在项目话题下仍能读 `cwd` 之外的文件。

实测对照（同一句 prompt：统计 `.codex\config.toml` 行数 + 执行 `echo ACP-OK`），模型 `gemini-4-carbon-high`：

| 配置 | 结果 |
| --- | --- |
| 1.0.x 默认（`search`，工作目录 = 运行时目录） | 两次都被拒：`工具权限 拒绝：…（kind=execute，策略=search）`；读文件报工作区不允许 |
| `toolPolicy=all` + 工作目录 = `C:\Users\sedirk` | 通过：`行数=158` + `ACP-OK` |

**1.1.0 起 `toolPolicy` 默认 `all`；1.2.0 起工作目录留空就跟随当前项目**，所以「读本项目 / 跑命令」开箱即用。
要读项目以外的盘（例如 `D:\tools`）才需要在面板把「工作目录」填成它的上级目录；填了就固定用它。
回答权限请求的是本插件这个客户端，**不需要在 Antigravity 界面里改什么**。

那为什么还是不能像 DeepSeek 原生 API 那样「随便读」？原生 API 的工具调用由 PI-Desktop 进程执行，
走宿主的审批与沙箱；ACP 是 Google 的二进制在**自己进程里**跑 `view_file` / `run_command`，
文件访问只能落在它自己认的工作区里。这是协议结构差异，不是插件 bug：把 `cwd` 放宽即可等效，
代价是模型能动的东西也一起变多。

实测（`gemini-4-carbon-high`，当时默认还是 `search`）：问「Antigravity 最新版本号」，agent 依次调用
`search_web`（返回「Antigravity App v2.30.0 · 2026-11-09」等真实结果）→ `read_url_content`
（读取 `antigravity.google/docs/changelog` 与 GitHub Releases）→ 再 `view_file` 读自己生成的步骤文件。

代价要说清楚：这是**多步 agent 循环**，不是单次 API 调用。一次带联网的提问会跑十几个工具调用，
几分钟很正常（实测单轮 4 分钟以上，主要耗在读自家步骤文件和反复核对来源）。不需要时效信息时
在提问里说明「不需要联网」，或把工具权限设成 `none`。

日志会记录每次放行/拒绝以及本次的工具使用统计，例如
`工具权限 放行：Run search_web?（kind=search，策略=search）`、`本次工具使用：search×2，fetch×2，read×8`。

## 对话时闪出的控制台窗口（1.3.0 起有说明）

用 `run_command` 这类工具时，Windows 上会闪出（有时一直留着）一个控制台窗口，标题是命令或
`D:\...\Scripts\conda.exe` 之类，里面可能只有一行
`[出现错误 2147942632 (0x800700e8) (启动 "...conda.exe" shell.powershell hook 时)]`。

来源拆开看很清楚（实测）：

1. **窗口本身**：运行时的 shell 工具每次起一个新控制台进程。Win11 把「新控制台」交给默认终端
   （这台机器上是 Windows 终端），于是每次命令都开一个窗口。插件没法替运行时的 shell 指定
   `CREATE_NO_WINDOW`——那是它自己进程内的行为。
2. **窗口里的报错**：PowerShell 的 profile（`Documents\WindowsPowerShell\profile.ps1`）里那段
   `conda init` 会无条件执行 `conda.exe shell.powershell hook`；没有交互式控制台时它写 stdout 失败，
   于是报 `0x800700e8`（管道已关闭）。
3. **顺带变慢**：带 profile 起一个 PowerShell 实测 **1494 ms**，`-NoProfile` 只要 **173 ms**，
   每条命令白等约 1.3 秒。

三种处置，按你想付出的代价挑：

| 做法 | 效果 | 代价 |
| --- | --- | --- |
| 工具权限调到 `agent`（或 `search`） | 完全不跑命令 → 不再有任何窗口 | 失去 `run_command`，读文件只剩 `view_file`（限 `cwd` + `~/.gemini`） |
| 改 profile：把 conda 那 4 行包进 `if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) { ... }`，或直接 `conda init --reverse powershell` | 报错消失、每条命令省约 1.3 秒 | 交互式终端里也不再自动激活 conda 环境（要手 `conda activate`） |
| Windows 设置 → 系统 → 开发者选项 → 终端 → 默认终端应用程序改成「Windows 控制台主机」 | 仍会闪，但窗口小、不开终端标签页 | 仅观感 |

插件这边能做的（1.3.0 已做）：**别让一次中断毁掉整个运行时**。以前客户端断开后 20 秒没停就杀运行时，
所有会话一起丢、下次还得重新握手；现在先 `session/close` 那一路 worker，再等 15 秒仍不停才杀。

## 流式、首字节与超时（1.4.0 起）

ACP 的一轮对话可能跑十几条工具、持续几分钟。为了让客户端**一开始就知道连接是活的**，1.4.0 改了三处：

| 机制 | 改前 | 改后 |
| --- | --- | --- |
| 响应头 | 预热（起运行时 + `session/new` + `set_model`）之后才 `writeHead`，实测 **10,455 ms** 才有第一个字节 | 先 `writeHead` + 首帧，实测 **53–59 ms** |
| 长工具链 | 只在有正文增量时才写字节，几十秒静默，容易被中间层判空闲超时 | 每 10 秒一个 `: ping` SSE 注释帧（实测 30 秒一轮里 3 个） |
| 工具进度 | 只在日志里记，前端一片死寂 | `chat` 端点下发 `reasoning_content` 增量（`· execute echo …`）；`responses` 端点发 `: 工具 …` 注释帧 |

另外，异常/中断时**不再丢已生成的内容**：`chat` 若已吐过正文就发 `finish_reason: length` + `[DONE]` 收尾，
`responses` 发 `status: incomplete` 且带 `incomplete_details.reason = stream_interrupted`；只有正文为空才发错误帧。

首字节变快只解决「看起来卡死」，**总时长仍由模型和工具链决定**：实测冷启动约 33 秒、热态约 7 秒出第一段正文，
每条约 300 ms 一段增量。要更快只能减少工具调用（面板把「工具权限」调成 `search` / `agent`）
或在提问里说明不需要联网/命令。

## 取消、会话回收与 resume（0.8.0 起）

**取消**：`session/cancel` 必须以**通知**（无 `id`、不等回复）发送——用请求形式会得到 `Method not found`，
这是之前误判「运行时不支持取消」的原因。现在客户端断开时会发通知，实测本轮以 `stopReason: cancelled`
结束，**运行时与会话都保留**（记忆不丢）。只有取消后 20 秒还没结束，才结束运行时兜底。

**会话回收**：运行时的 worker 只有 `session/close` 才会退出，光删本地映射会泄漏进程
（每个都不小）。现在空闲 `idleSessionMinutes`（默认 10 分钟）或会话数超上限时发 `session/close`，
但保留映射；同一对话再来时先 `session/resume`（不重放历史），失败才新建。

**会话键**：原先单轮对话的历史前缀为空，任意两个单轮对话会算成同一个 key、共用同一个会话
（实测把 A 的上下文带给了 B）。现在空前缀会补上首条消息做判别位，并加了回归测试。

运行时崩溃/被杀时会清空会话缓存（旧 `sessionId` 已失效，不清空会让后续请求报错）。

## 已知边界

- 只保证 Windows 的自动下载；其他平台请手动放置运行时并填 `bin` 路径
- **卸载插件不会删除运行时**（约 227 MB）。运行时放在插件数据目录 `plugins\data\local.antigravity-acp\runtime\`，
  卸载前请先执行命令「Antigravity: 清理已下载的运行时」，或在面板点「清理运行时」释放空间
- 退出时会用 `taskkill /T` 结束整棵进程树；插件启动时还会清掉「父进程已退出」的残留运行时，
  避免多个 ACP 实例共享同一账号额度导致偶发超时
- 输入只有文本 + 图片 + PDF 附件；工具调用由 agent 自己执行，网关只按「工具权限」放行或拒绝，
  不把 `tool_call` 映射成 OpenAI function calling
- 模型切换（`session/set_model`）失败时会重试一次，仍失败则直接报错，**不会用会话默认模型代替**回答
- 思考内容（`agent_thought_chunk`）已接入 `reasoning_content` / `reasoning` item，
  但实际是否出现取决于模型与档位（本运行时 1.3.0 实测不发）
- 额度、限流与条款解释权在 Google 侧；请不要多账号轮换或当高并发后端使用

## 开发

```powershell
node test/run-tests.js
```

覆盖配置单源与迁移、并发限制（不限/串行/超时/队满）、模型分组与 `reasoning_effort` 解析、
两种请求体归一化、图片与文档块转换、工具权限策略（含 `shell` 档与 `all` 默认）、工作目录默认值、会话键、usage 估算。
测试不联网、不启动运行时。

## 参考实现

以下项目是 MIT 许可的同类实现，本版只借鉴协议用法（未复制代码）：

- [angusggsimid/dsh-antigravity-acp](https://github.com/angusggsimid/dsh-antigravity-acp)（DeepSeek Harness 插件）：
  `session/cancel` 用通知形式发送、`session/close` 回收 worker、`session/resume` 接回会话、
  拒绝权限时优先用它自己的 `reject` 选项而不是裸 `cancelled`。
  其中 `_meta.antigravity.systemPrompt.append` 在本地 server 版运行时（agy_acp_server 1.3.0）实测不生效，故未采用。
- [xp26Ai/antigravity-openai-bridge](https://github.com/xp26Ai/antigravity-openai-bridge)、
  [anglee0323/agy-bridge](https://github.com/anglee0323/agy-bridge)：同类 ACP→OpenAI 桥的会话与工具接入思路对照。

两条也验证过**做不到**，写在这里免得重复踩：

- **额度（5 小时/每周窗口）**：DSH 那条路要走 `agy -p /usage`（Antigravity CLI）。本机只装了 server 版
  `agy_acp_server.exe` + `localharness_external.exe`，没有 `agy` CLI，ACP 协议里也没有额度窗口，故无法提供。
- **思考摘要**：试过 `_meta` 的 `thinking.summaries`、`thinkingSummaries`、`includeThoughts` 三种形状，
  思考块都是 0 字——运行时 1.3.0 不下发 `agent_thought_chunk`。

## 许可与来源

本插件原创代码使用 AGPL-3.0（见 `LICENSE`）。

运行时不属于本仓库：它由 Google 发布在
`https://dl.google.com/agy-extensions/releases/...`，插件只提供下载与校验，不再分发。
ACP 协议见 <https://github.com/agentclientprotocol/agent-client-protocol>。
