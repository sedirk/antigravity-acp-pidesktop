# 变更记录

## 1.5.3

自动续跑真正生效（1.5.0 的判断依据是错的）：

- **实测 `session/prompt` 的返回值是空的**（日志 `本轮 stopReason=(空)`），运行时不会告诉我们「被上限截断」；
  1.5.0 靠 `stopReason: max_turn_requests` 判断，永远不触发。改为行为判据：
  **这一轮跑过工具、却一个字正文都没有** → 判定被截断
- **同一条会话续跑没用**：撞上限后原会话不再产出任何事件（实测续跑 180 秒零更新，被看门狗取消）。
  改为 `session/close` 掉旧会话 + `freshSessionFor()` 新建会话续跑，并清掉会话映射避免下一轮 resume 到死会话
- **续跑会从头再跑一遍**：把已执行过的工具标题记进 `stats.toolLog`，续跑提示里带给新会话
  （实测第 1 轮 STEP-1…6，续跑 1 直接 STEP-8/9/10，续跑 2 到 STEP-12，没有重复）
- 续跑结束后若既无工具也无正文，补一次「请直接给出最终答复，不要再调用工具」
- 未完成时 `/v1/responses` 按 `status: incomplete` 收尾（不再是假装 completed）

**已知未解**：跑满多轮工具后（实测 ~15 次），运行时不再产出任何正文，连「只要最终答复」也不回。
这是运行时行为，非网关可修；建议把大任务拆小，或让模型先给结论再动手。

## 1.5.2

「第 10 分钟整轮被砍」与「Concurrent receive_steps」两处硬伤：

- **硬上限 10 分钟 → 60 分钟**：`promptTimeoutMs` 默认从 600000 改成 3600000。日志实锤：
  `02:08:16 新会话` → `02:18:16 流式中断（已保留 1185 字）：ACP session/prompt 超时（600000ms）`，
  正好 600 秒。活动看门狗没触发是对的（gemini 一直在报工具进展），真正砍掉它的是这个固定上限
- **新增「无进展判定」**：`promptIdleTimeoutMs` 默认 180 秒，面板可调（「无进展判定（秒）」）。
  只要运行时还在报 `session/update` 就永不触发；真卡死才 `session/cancel`
- **prompt 串行化**：运行时同一连接不支持并发 `receive_steps()`，宿主上一轮未收尾又发一轮就会报
  `Concurrent receive_steps() calls are not supported on this connection`。现在后来的 prompt 排队
  （日志会写「另一轮 prompt 尚未结束，本轮排队」），不再并行打到同一连接
- 撞到硬上限时先发 `session/cancel` 再结束本轮，避免把「还在跑的那一轮」留给下一次请求踩
- 面板「单次回答超时」上限从 60 分钟放宽到 120 分钟，并新增「无进展判定（秒）」输入

## 1.5.1

上下文百分比不再恒为 2%：

- PI-Desktop 的上下文标签读的是 `/v1/responses` 里 `response.usage.input_tokens`
  （宿主源码 `openai-responses-shared-*.js` 的 `finalizeResponse`）。旧实现把「本轮发给运行时的文本」
  估算成 `input_tokens`——会话复用后那只是一句增量（甚至就是「继续」），所以标签恒定停在 1–2%
- 现在只要运行时上报了 `usage_update.used`（真实累计上下文），就直接拿它当 `input_tokens`，
  `estimated` 相应变为 `false`；拿不到真实值才退回字符估算
- 实测（同一会话两轮）：`input_tokens 11,255 → 11,465`，与日志里的 `上下文占用` 完全一致且逐轮增长

顺带说明：这不是 Responses 协议的问题；Responses 路径只是让「截断」更安静（旧错误帧是 chat 端点格式，
Responses 客户端只认 `response.failed` / `response.completed`），1.5.0 起已按 Responses 语义收尾。

## 1.5.0

把「说到一半断掉」「每轮都从零重来」「段落粘连」的四个真凶一并修掉（不是再加心跳）：

- **会话键不再随轮次变化**：旧实现哈希 `messages.slice(0,-1)`，第 1 轮存 `hash([S])`、第 2 轮算
  `hash([S,U1,A1])` 必然不命中，于是**每轮都新建 ACP 会话**——实测日志里全是「新会话 · 首帧 7–11 秒」，
  还要把整段历史重新压平重发。现在优先用宿主给的 `prompt_cache_key` / `conversation_id` /
  `metadata.conversation_id`，否则用「系统提示 + 首条 user 消息」这种跨轮不变的标识。第 2 轮起命中
  `session/resume`，实测省掉每轮 7–11 秒预热
- **轮内步数上限自动续跑**：运行时的单次 `session/prompt` 到第 10 个工具调用就返回
  `stopReason: max_turn_requests`，旧代码直接 `response.completed` 关流——这就是「话说到一半没了」。
  现在识别 `max_turn_requests` / `max_tokens`，在同一条会话里自动续跑（最多 4 次，每次只发「继续」），
  增量照常流给客户端；仍然到顶才按未完成收尾并在日志标注
- **段落不再粘连**：工具调用前后的两段播报属于不同发言段，现在补 `\n\n` 分隔（`/v1/responses` 与
  `chat` 两条路径同一套逻辑）
- **活动看门狗取代固定总超时**：判据从「整轮最多 10 分钟」改成「120 秒完全没有进展」（可配
  `promptIdleTimeoutMs`）。持续有工具进展的长任务不会再被整轮超时误杀；真卡死时发 `session/cancel` 而不是干等
- **`http.Server` 显式放宽超时**：Node 默认 `requestTimeout = 300 s`，带工具的一轮轻松超过 5 分钟，
  默认值会在第 300 秒把长连接掐掉（客户端表现为断流）。现在 `requestTimeout = 0`、`headersTimeout` /
  `keepAliveTimeout` 各 120 s
- **模型探测不再泄漏 worker**：`discover()` 每 5 分钟 `session/new` 一次却从不 `session/close`，后台
  worker 会一直堆积；现在探测完立即关闭
- 自测 20/20（新增跨轮会话键、宿主会话标识优先、会话标识隔离三组断言）

## 1.4.2

把两个端点里重复的 SSE 样板合成一个 `openSse(res)`（行为不变）：

- 之前 `chat` 与 `responses` 各写了一遍 `writeHead` / `setNoDelay` / 心跳定时器 / 关闭清理 / 中断统计，
  约 40 行几乎相同；现在只有 `openSse()` 一处，端点只关心「发正文 / 发事件 / 发注释 / 收尾」
- 结构与参考实现 `dsh-antigravity-acp` 的 `#sseOpen` 对齐（那是最小可用形态：写头 → `: open` → 定时 ping → 关闭清理）
- 顺带把心跳、`socket.setTimeout(0)`、`sequence_number` 自增、帧数统计集中到一处，避免两个端点行为漂移
- 自测 20/20；三组流式实测（冷启动首字节 / 带命令心跳 / responses 事件序列）复跑通过

## 1.4.1

心跳加密 + 断开现场可诊断：

- 心跳从 10 秒改为 **5 秒**。日志显示客户端会在「完全没有字节」的窗口里断开，实测案例分别发生在
  起手 **1.7 s / 5.9 s / 7.4 s / 51 s**，10 秒间隔覆盖不到 5 秒级的空闲超时
- 新增中断现场日志：`流被客户端中断 <id>：历时 N ms · 已发 N 帧 · 正文 N 字 · 距最后一次写入 N ms`。
  以后半句被截断时，看这一行就能区分「客户端超时断开」「用户主动停止」「网关自己出错」
- 实测：主动 abort 后日志输出 `历时 12039 ms · 已发 2 帧 · 正文 0 字 · 距最后一次写入 2013 ms`
- 自测 20/20

## 1.4.0

流式与超时修复（对应「输出很怪 / 超级慢 / 说着说着就断」）：

- **首字节**：`chat` 与 `responses` 原来在 `writeHead` 之前就 `await acp.start()` + `discover()` +
  `session/new` + `set_model`，冷启动十几秒里客户端连响应头都拿不到。实测改前 **headers 10,455 ms**，
  改后 **53–59 ms**（首个正文字节仍取决于模型：冷启动约 33 s，热态约 7 s）
- **心跳**：prompt 期间每 10 秒写 `: ping`（SSE 注释帧），长工具链不再静默。实测 30 秒的一轮里 3 个心跳帧；
  做法与参考实现 `angusggsimid/dsh-antigravity-acp`（`index.js:1575-1577`）一致
- **工具进度可见**：`chat` 端点把 `tool_call` / `tool_call_update` 作为 `reasoning_content` 增量下发
  （形如 `· execute echo STREAM-OK`，不进正文、不进最终 message）；`responses` 端点用 SSE 注释帧，
  不污染 Responses 事件流。改前几十秒里前端一片死寂
- **断流不再吞掉已生成内容**：异常时若已吐过正文，`chat` 发 `finish_reason: length` + `[DONE]` 正常收尾，
  `responses` 发 `status: incomplete` + `incomplete_details.reason=stream_interrupted`；
  只有正文为空时才发错误帧。改前一条 error 帧会把已写出的半篇答案整个作废
- `responses` 端点补发 `response.in_progress`
- 实测：`chat` 正文 6 个增量帧、间隔约 300 ms；`responses` 事件序列
  `created → in_progress → output_item.added → content_part.added → output_text.delta → … → completed`
- 自测 20/20；另用独立端口跑仓库代码做三组流式实测

## 1.3.0

中断不再毁掉整个运行时 + 弹窗问题写进文档：

- **取消兜底改两步**：客户端断开后 20 秒仍未结束，先 `session/close` 这一路 worker（只影响这条会话），
  再等 15 秒仍在跑才结束整个运行时。旧版直接杀，所有会话一起丢、下次重新握手 15–20 秒
  （实测日志：`取消后 20 秒本轮仍未结束：结束运行时兜底` → `ACP 运行时退出 code=1`）
- README 新增「对话时闪出的控制台窗口」：窗口来自运行时为每条命令起的新控制台 + Win11 默认终端；
  报错来自 PowerShell profile 里无条件的 `conda init` 钩子（`0x800700e8`）；实测带 profile 1494 ms、
  不带 173 ms。给三种处置（调低工具权限 / 改 profile / 改默认终端）
- 面板「工具权限」提示补充：每多放行一档就多闪一个窗口，想彻底不弹窗选 `agent` / `search`
- 自测 20/20（取消路径未新增单测，靠日志与 e2e 复核）

## 1.2.1

文档修正（实测发现 `cwd` 只管文件工具，不管命令）：

- 项目话题下实测 `run_command` 仍能读取 `cwd` 之外的路径（`Get-Content C:\Users\sedirk\.codex\config.toml` → 行数=158），
  所以 `cwd` 是**文件工具的白名单根**，不是命令沙箱；面板与 README 文案改成这一说法
- 临时话题（宿主没项目）实测 `cwd` 回退主目录，`view_file` 与 `run_command` 都读得到 `~/.codex/config.toml`

## 1.2.0

工作目录跟随 PI-Desktop 项目：

- **`cwd` 留空 = 跟随宿主当前项目目录**（`pi.workspace.get()`），拿不到才回退用户主目录；
  之前留空是用户主目录，跟当前打开的项目无关
- 每次建会话（`session/new`）现问一次宿主，切换项目后不用重启网关；面板填了值则以面板为准
- 修掉 `session/new` 与附件目录在 `lib/server.js` 里还回退到「运行时所在目录」的旧逻辑
  （1.1.0 只改了模型发现那条路径，所以真实对话的 `cwd` 之前并不跟着改）
- 面板「工作目录」改为「留空 = 跟随 PI-Desktop 当前项目目录」，并提示留空时实时取值
- 自测 20/20（新增 `cwdFor` 优先级：面板值 → 项目目录 → 用户主目录）

## 1.1.0

权限默认值收口（针对「PI-Desktop 里给了全部权限，Gemini 却读不到文件 / 跑不了命令」）：

- **`toolPolicy` 默认从 `search` 改为 `all`**：本插件不再默认当第三道防火墙。
  真正的边界是运行时的工作区白名单与宿主审批；想收紧才主动调 `shell` / `agent` / `search` / `none`
- **`cwd` 默认从「运行时所在目录」改为用户主目录**：装好即可读写个人目录下的项目与配置，
  之前默认只允许读插件自己的 runtime 目录，所以连 `~/.codex` 都打不开
- 新增 `shell` 档：放行 `execute`（`run_command` 等），仍挡住写文件；面板可选，也可用请求级 `tool_policy` 指定
- 面板：选项重排（`all` 在最前并标「默认」），「工作目录」补一句「填得越宽，模型能动的东西越多」，
  保存时校验目录是否存在
- README 新增「三层权限」一节：宿主插件权限 / 本插件 toolPolicy / 运行时工作区，附实测对照与「为什么不等同原生 API」
- 自测 20/20（`shell` 档矩阵、`all` 默认值、`cwd` 默认与校验）

- 面板「查看状态」与命令「显示网关状态」显示工具权限与最近一轮（耗时 / 上下文）
- 新增 `CHANGELOG.md`、`TODO.md`；README 补兼容性与版本历史

## 0.9.0

- 请求级工具策略：`tool_policy` 字段；宿主声明 `web_search` 时临时放宽到 `search`
- 每次回答追加 `usage.jsonl`（5MB 轮转），`/health` 暴露 `lastRequest`
- README 记录两条做不到的路线（额度需 CLI、思考摘要不下发）

## 0.8.0

- `session/cancel` 改为**通知**形式发送：取消本轮且保留运行时与会话（旧版是杀进程）
- `session/close` 回收 worker（空闲 `idleSessionMinutes` 或超上限），`session/resume` 接回
- 修复单轮对话会话键碰撞（A 的上下文会带进 B）

## 0.7.0

- 新增 `agent` 工具档（放行子代理/后台任务/生图，仍挡写文件与执行命令）
- 接 `usage_update`：`context_used` / `context_size` 为运行时真实值
- 客户端断开 → 没有并发请求时结束运行时以中止 agent 循环（0.8.0 已改为取消通知）

## 0.6.0

- 正确回答 `session/request_permission`，agent 自带的 `search_web` / `read_url_content` 得以生效
- 面板新增「工具权限」（`search` / `all` / `none`）

## 0.5.0

- PDF / 文档输入：`input_file`、`file`、`document` → 落盘 + `resource_link`
- 实测内联 blob 的 `resource` 块运行时不认；放系统 temp 会被 `view_file` 白名单拒绝

## 0.4.x

- 0.4.0 图片输入（`image_url` / `input_image` → ACP `image` 块）
- 0.4.1 `usage` 估算 + 模型落点日志 + 被忽略参数提示 + `/v1/models` 能力元数据
- 0.4.2 README 更正：宿主只从模型行读 `contextWindow` / `maxTokens`，不读 `modalities`

## 0.3.x

- 修 `set_model` 失败时静默改用别的模型 → 改为重试一次后直接报错
- 结束整棵运行时进程树（`taskkill /T`）+ 清理父进程已退出的孤儿
- 代理三档（`auto` / `manual` / `direct`）、默认思考档位可配

## 0.1.0 – 0.2.0

- 首个可用版本：ACP→OpenAI 网关、虚拟模型 + `reasoning_effort`、并发限制、代理注入、
  面板下载并校验官方运行时
