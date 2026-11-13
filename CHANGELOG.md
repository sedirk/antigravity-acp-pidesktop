# 变更记录

## 2.2.1

- **无缝切模型与超长会话平铺清洗（Seamless Model Switching & Context Clean-up）**：
  - **根因彻底查明与修复**：从旧模型（如 gpt-6-astra）切换至新模型（如 gemini-4-carbon）时，由于历史 Assistant 回复在多字节截断处残留断头 UTF-8（如 0xE6 0x9F 被中途劈开，后余 496 字节），导致新模型误将历史截断当作“用户最新输入截断”，主动触发 15 次本地读取自愈；
  - **`canonicalizeText` 规范化强化**：清洗 Unicode 替代符 `\uFFFD` 及孤立代理对，闭合非法边界；
  - **结构化隔离历史背景与当前提问**：跨模型全量平铺（`flatten`）时，采用 `=== 对话历史 (Conversation Context) ===` 与 `=== 当前用户请求 (Current User Request) ===` 明确划分语义角色，杜绝新模型将上一轮尾部误当成当前输入；
  - **超长历史智能剪枝与复用 Compaction**：优先复用 PI-Desktop 已有的压缩摘要，未压缩超长历史（>20轮）智能保留系统提示与最近上下文，显著降低首帧延迟（TTFT）。
- **思考流纯净化与静默调度（Thought Stream De-noising & Silent Scheduling）**：
  - **彻底取消向思考流输出内部排队与看门狗猜测文字**：移除所有塞入 `agent_thought_chunk` 的排队提示和看门狗提示（`· 检测到前序任务正在运行...` / `· 正在等待模型首个响应...`），思考流 100% 保持为模型原生推理；
  - **修复空闲会话假排队**：修正 `isBusy` 判定逻辑，杜绝 `session/load` 恢复空闲会话时误判为 busy，排队保护仅在服务端内部控制台静默生效。

## 2.2.0

- **原生支持云端前缀缓存对齐（Prefix Cache Alignment）**：
  - 工具目录引导词（`guidanceFor`）按工具名称进行严格字母升序稳定排序，确保不同顺序传入工具生成的引导词 100% 字节级对齐；
  - 首轮对话固定注入锚点引导词，后续增量轮次（resume）复用会话上下文，避免重复注入破坏前缀缓存，大幅提升 Google TPU 集群 KV Cache 命中率并降低 TTFT 延迟。

## 2.1.15

- **修复「停止之后修改重新对话，修改补充的内容进不去」的核心缺陷**：
  - **分支与修改版本检测（Branch Revision Detection）**：会话层引入历史用户提问签名比对与中断标记。当用户在客户端停止生成后，修改/补充上一轮提问重新生成（生成版本 `< 2 / 2 >`），或在多轮历史中编辑任一轮历史提问时，精准识别为分支修改，自动优雅关闭并重置旧会话，绝不再把修改内容当成旧会话追加增量，确保模型 100% 完整接收最新修改补充的内容；
  - **彻底清理客户端断开（停止 / Abort）残留状态**：在 `watchDisconnect` 中强化清理，连接断开时立即向 ACP 运行时发送 `session/cancel`，同步清理同会话所有挂起工具（`parked`）与运行状态，打上 `interrupted` 状态；
  - **解除工具挂起死循环重发**：桥接层在工具未回填时，只要检测到用户包含任何新的提问或修改，立即放弃旧挂起工具调用并重置状态，杜绝死锁重发旧 tool_calls；
  - **全量测试套件扩充**：离线单元测试 35/35 通过，网关回归测试 30/30 通过（新增「停止后修改提问重新生成版本 2」专项端到端用例）。

## 2.1.14

- **全面支持轮中补充与改变方向（Steering）**：
  - 导出模型元数据中补充 `canSteer: true`、`supports_steering: true` 与 `capabilities` 中的 `steer` 声明，打通 PI-Desktop 宿主输入框与会话层对 Steering 功能的识别；
  - 桥接轮次调度升级：在 AI 正在生成回答或思考时，若收到用户新意图请求，立即向底层运行时发送 `session/cancel` 打断在途生成，优雅结算前一轮连接，快速释放串行锁并无缝接管执行最新用户指令；
  - 严格区分主动 Steering 与无进展超时：用户主动中断或转向时完整保留健康业务会话与上下文历史，彻底杜绝误销毁 / 误关闭会话。
- **修复配置面板通道报错（`未知的面板通道: config:get`）**：
  - 补充 `config:get` 与 `config:save` 双向通道别名映射；
  - 修复 `main.js` 中 `runtime:cleanup` 后的分支大括号语法嵌套闭合错误，恢复 `sessions:list` 与 `sessions:recycle` 的正确分发。
- **配置面板新增「3. 在模型面板中添加使用」极速接入引导**：
  - 在 Google 账号认证下方新增 3 步直观配置卡片，详述 OpenAI 兼容端点（支持当前端口联动与一键复制）、密钥留空、协议格式选择与推荐虚拟模型 ID 快捷复制，直通即用体验。
- **全量测试套件扩充**：离线单元测试 35/35 通过，网关集成回归测试 29/29 通过（新增轮中 steering 打断并即时切换新方向回答专项用例）。

## 2.1.10

- **修复「工具回交挂起 + 宿主中途自动压缩」双向死锁**：桥接轮次挂起等待宿主回填工具结果时，底层 `session/prompt` 仍占着串行锁；宿主此时若插队发来同 `prompt_cache_key`、无 `tools` 的自动压缩请求，旧实现走普通分支排在锁后互等卡死。现在收到同会话无工具请求时自动释放挂起项并 `session/cancel`（超时未退则 `abandon` 放锁）；客户端中断排队请求时也会同步解开同会话的挂起锁。
- **旁路无工具请求（自动压缩 / `/compact`）隔离到独立临时会话**：已绑定工具桥的对话收到单条 `user` 无工具请求时，改用独立 `session/new`（`mcpServers: []`、`policy=none`）并在请求结束后立即 `session/close` 回收 worker，避免摘要指令污染原业务会话；若被抢占轮次末尾已有宿主跑完的工具结果，下一轮续跑自动补齐。
- **多步桥接续流与跨重启保留运行时真实 `contextUsed`**：修复第 2+ 次 `park` 因每轮新建空 `stats` 而退化为按本地原始历史估算虚高 token（进而过早触发宿主自动压缩）的问题，并将 `contextUsed` / `contextSize` 持久化进 `sessions.json` 及 `session/load` 恢复链路。
- **网关与桥接稳定性增强（P1–P4）**：命名空间工具名规范化与回填、并行 MCP 工具调用微批合并、单连接串行锁与并发限流解耦、CORS/`OPTIONS` 204 预检与超限请求优雅返回 HTTP 413、闲置会话管理。
- 回归测试：离线 **33/33**、HTTP 行为 **28/28**、专项 **11/11**（共 72 项全部通过）。

## 2.1.9

- **挂起等宿主执行工具时，不再被「无进展」看门狗砍掉**。桥接挂起期间运行时在等宿主，按设计一个
  `session/update` 都不会有；看门狗却按 180 秒算无进展 → 发 `session/cancel`、关会话。
  用户看到的就是「卡 3 分钟然后重置」。现在 `stats.parked` 会让看门狗在这段时间只发心跳
  （`· 等待宿主执行工具 X…`），不判定卡死。
- **工具结果按对话路由**（真 bug）：`parkToolCall` 原来挑「第一个空闲的桥接会话」，多个对话同时在线时
  会把工具结果回填进别的对话，而且不报错。现在每个对话拿到带键的端点
  （`/mcp?k=<对话键>`），MCP 请求按 key 精确落位，匹配不到才回落到旧行为。
- 回归测试：离线 29/29、HTTP 行为 **23/23**（新增「挂起的工具调用不算卡死」，跨过整个无进展窗口断言不发
  `session/cancel`）。

## 2.1.8

- **单轮硬上限默认关掉（0 = 不设上限）**：这个参数是早期「怕一轮永远不返回」的补丁，实际代价更大——
  实测今天有 **19 次**整轮在 600 秒被拦腰砍断（`session/cancel` + `session/close`），
  而真正「无进展」的看门狗只触发 **2 次**。长任务本来就该能跑几小时。
  现在 `promptTimeoutMs` 默认 `0`，面板里填 0 就是关掉（`min=0`，上限 24 小时只是防手滑）。
- **`timeoutMs=0` 真的永不超时**：`core.request` 原来会 `setTimeout(..., 0)` → 立刻超时；
  现在只在 `timeoutMs > 0` 时挂定时器，并且清理时判空。
- 止损仍然在：`promptIdleTimeoutMs`（默认 180 秒无任何 `session/update` 才取消本轮），
  工具还在报进展就不会被砍。
- 自测：离线 29/29（新增「0 不能被夹回 1 分钟」「timeoutMs=0 不自己超时」）、HTTP 行为 22/22。

## 2.1.7

- **修「重启电脑后连不上」的根因：代理被开机那一瞬间定死了**。`proxyMode=auto` 原来只在插件服务启动时
  解析一次（`resolvedProxy` 永久缓存），而 VPN/代理软件往往比 PI-Desktop 起得晚 —— 开机查到「系统代理未启用」
  就永久按直连走，运行时之后再也连不上网。表现为模型发现、`session/load`、`prompt` **全部 `Internal error`**。
  现在：`auto` 每次启动运行时现读注册表（5 秒缓存），不再一次定终身；`/health` 的 `proxy` 字段直接显示
  运行时实际用的网络路径。
- **直连起、后来有代理 → 自动重建一次运行时**（单向）：运行时的网络路径是 spawn 那一刻定死的，只能重建。
  只在「直连 → 有代理」方向触发，反向不动（免得开关 VPN 反复重建）；有轮次在跑就等下一轮。
- 真机证据（就是这次事故）：`gateway.log` 开机 `代理：直连（none：系统代理未启用）` → 之后每轮
  `模型发现失败 / session/load 失败：Internal error`，运行时 stderr 为
  `oauth2.googleapis.com ... ProxyError('Unable to connect to proxy')`；同一时刻 `resolveProxy()` 已能解析出
  `http://127.0.0.1:10808` —— 说明问题在「缓存了开机结论」，不在系统代理。
- 自测：离线 28/28、HTTP 行为 22/22（新增「直连起→发现代理只给一次重建信号」「重建后本轮继续」）。

## 2.1.6

- **缓存前缀审计**：把「哪些操作会逼服务端重算前缀」逐条对着代码和真实运行时核了一遍。
  网关能控的只有一件事——**别把会话扔掉、别重放历史**。这一版补掉剩下两个会重放的漏洞：
  - 内存映射被淘汰（空闲回收、会话数上限）时，原来连 `sessions.json` 足迹一起删；现在只删映射、保留足迹，
    下次同一对话先 `session/load` 接回来（不再整段重放）。
  - `session/load` 还原出来的会话带着上次的模型，原来不切档位就直接用——换模型后等于静默忽略用户的选择。
    现在还原后显式 `session/set_model`，切不过去才重建。
- **桥接地址变了不再重建会话**：桥接开关、或内部桥接端口变化时，原来 `session/new` 重建（整段历史重放一遍）；
  现在先 `session/close` 放掉 worker，再 `session/load` 带新 `mcpServers` 重新挂载，失败才回落重建。
- **足迹保留 7 天（上限 500 条，按最久未用淘汰）**：实测 `session/close` 之后 `session/load`/`resume` 历史仍在，
  所以「运行时早回收了」不是丢足迹的理由；留着才可能省下一次整段重放。
- 实测证据：
  - 原语探针：`session/new` → 记暗号 → `session/close` → `resume` 与 `load` 两条路都答出了暗号（`APRICOT-6620`）。
  - 真机跨重启：carbon-medium 记暗号 → 关网关 + 杀运行时 → 新网关/新运行时用 3.8-flash 提问；
    日志为「已用 session/load 还原会话 …（不再重放）」+「模型切到 gemini-3.8-flash-low（复用会话，不重放历史）」，
    `sessions.json` 里 sessionId 未变、模型更新为新档位，回答仍是 `WALNUT-5150`。
- **仍是 cache miss 的**（网关无能为力，免得再排查）：换模型/换档位（Google 按模型隔离缓存）、
  宿主压缩上下文（改写历史，前缀全变）、缓存 TTL 到期。`cached_tokens` 依旧拿不到：ACP 只给 `{used,size}`。
- 自测：离线 27/27、HTTP 行为 21/21（新增「还原后按本轮模型切换」「桥接变化重挂载而非重建」）。

## 2.1.5

- **运行时状态可见 + 一键重启**（不做自动重启）：
  - `/health` 与面板「查看状态」新增 `workers`：运行时派生的 `localharness_external` 数量与总内存
    （`tasklist` 采样，结果缓存 30 秒，非 Windows 返回 `supported:false`）。
  - 面板新增「重启运行时」按钮（带确认框）：杀掉整棵运行时进程树并清空会话映射，
    下一次请求由 `ensureRuntime()` 自动拉起；会话足迹仍在，下次发言会先尝试 `session/load` 接回。
  - 真机验证：`restartRuntime → {pid:4548, stopped:true}` → 1.5 秒后 `status.pid=null`（进程树确实没了）
    → 第二轮请求自动拉起新运行时（pid 24712）并正常回答 → `/health` 返回 `workers:{count:5, memMB:612}`。
- **没有做自动重启**：实测 worker 会随 `session/close` 回收（3 个左右是正常水位），
  之前观察到的 12 个是连续跑 e2e 造成的尖峰，不是泄漏。自动重启会丢运行时进程内状态、
  多一次 `session/load`、还要重做模型发现，收益不成立，所以只提供手动开关。
- 自测：离线 27/27、HTTP 行为 19/19。

## 2.1.4

- **会话键彻底去掉模型维度**：2.1.3 只是去掉了档位后缀，换**模型**（如 `gemini-4-carbon` → `gemini-3.8-flash`）
  仍然会新建会话。实测证明这不是必要的：同一 ACP 会话里 `carbon-high → 3.8-flash-low → carbon-medium`
  来回切，暗号照样记得，运行时的 `set_model` 每次都成功。
  现在 `keyFor(messages, req)` 只按对话身份取键，换模型/换档位一律走 `session/set_model` 热切换。
  换模型导致失败（例如新模型不支持历史里的附件）才重建会话，绝不拿旧模型冒充。
- 真机验证：同一对话三次请求跨两个模型，**只建 1 个会话**，后两轮日志为「续会话」+「模型切到 …（复用会话，不重放历史）」，
  3.8-flash 与切回 carbon 都答出了此前记住的暗号。
- 日志措辞从「档位切到」改为「模型切到」（它现在也用于换模型）。
- 自测：离线 27/27、HTTP 行为 19/19。

> 仍然成立的事实：Google 侧 prompt cache 按模型隔离，换档位/换模型必然 cache miss。
> 这一条省的是**会话重建与历史重放**，不是缓存。

## 2.1.3

- **切思考档位不再重建会话**：会话键原本包含具体模型（`gemini-4-carbon-high/low` 是不同 key），
  所以每调一次档位就等于换对话：新建 ACP 会话 + 重放整段历史（实测同一句「hi」在四个档位下得到 4 个不同 key）。
  现在键只用去掉档位的基础名，档位差异走 `session/set_model` 在同一会话上热切换；切换失败才重建，绝不拿旧档位冒充。
  真机验证：high → low → medium 三次请求只建 1 个会话，后两次日志为「续会话」+「档位切到 …（复用会话，不重放历史）」。
  注意：这不会让 Google 侧的 prompt cache 跨档位命中——缓存按模型隔离，切档位必然 cache miss（该省的是会话重建与历史重放）。
- **首字等待不再静默**：等待期按 `idleMs/6`（最多 30 秒）发一次「仍在等待模型首个响应（已 N 秒）…」，
  最多 3 次。心跳**不**更新活动时间戳，无进展判定照常在其阈值触发（顺序也调正了：判定优先，避免心跳把判定一直推后）。
- 自测：离线 27/27、HTTP 行为 19/19（新增「换档位不换会话」「静默首字发心跳且不推迟判定」）。

## 2.1.2

- **配置面板改为分区卡片**：每个分区是一张卡片，标题独占整行、卡片内部两列，窄屏自动单列。
  之前 `<h3 class="section">` 没有跨列，标题只占左列，导致右侧字段错位、看起来一栏挤一栏空。
- 修掉 `promptTimeoutMinutes` 缺失 `</div>` 造成的嵌套（它的字段把「无进展判定」包进了自己内部，
  这两项因此在网格里各占一行）。
- 「工具与桥接」重排：`工具回交` 与 `客户端名称` 并排，`会话空闲回收` / `桥接提示层` / `工作目录` 占整行，
  不再出现半行孤字段。
- 提示层说明同步为「按阶段汇报」的新行为。

## 2.1.1

- **修复 MODEL_SWITCH_FAILED（`Model 'gemini-4-carbon' is not available for the current authentication method.`）**
  - 根因：`resolveModel()` 依赖模型发现的缓存分组；预热失败或运行时重启后缓存为空，
    它就把**裸虚拟名** `gemini-4-carbon` 原样发给了 `session/set_model`。运行时只认带档位后缀的 id，
    于是每一轮都失败，且看起来像「认证方式不支持这个模型」。
  - 取证（运行时日志）：`set_model gemini-4-carbon → 拒绝`，`set_model gemini-4-carbon-high → OK`，
    `set_model gemini-4-carbon-medium → OK`。同一账号、同一认证方式，只是 id 写法不同。
  - 修复：`resolveModel()` 改成 async，缓存为空时先补一次模型发现；解析结果绝不可能是裸虚拟名
    （补 `-low/-medium/-high`，缺档位默认 `medium`），列表已知但确实没有该模型时抛 `MODEL_UNAVAILABLE`
    并附上可用列表，不再静默换模型。
  - 配套：运行时退出时清空模型发现缓存（进程换了列表可能变）；`discover()` 单飞，
    缓存为空时的并发请求不会各建一个探测会话。
  - 真机验证：裸名 + 无 effort → `gemini-4-carbon-medium`；`effort=low` → `gemini-4-carbon-low`；
    不传 model（默认 `gemini-4-carbon`）→ `gemini-4-carbon-medium`，三例都正常回答。
- 自测：26 个离线用例 + 18 个 HTTP 行为用例全过（新增「缓存为空也不发裸名」「未知模型必须报错」断言）。

## 2.1.0

- **跨重启会话恢复**：网关重启（连运行时一起重启）后，同一轮对话用 `session/load` 接回，不再重放整段历史。
  - 依据：运行时 `initialize` 明确回了 `agentCapabilities { loadSession: true, sessionCapabilities: { list, resume } }`。
  - 实现：`lib/session-store.js` 只存「对话键 → sessionId」（不含任何对话内容），落盘到数据目录的 `sessions.json`，
    一天没动过的足迹自动丢弃；`session/load` 带上 `cwd` 与 `mcpServers`，所以工具桥照样挂得上。
  - 失败回落：`session/load` 报错就删掉足迹、用 `session/new` 重建（原有逻辑不变）。
  - `load` 会把历史以 `session/update` 重放回来，网关临时挂空 handler 吞掉，避免重放内容混进本轮正文。
  - 实测（真运行时 1.3.0）：第一轮让它记暗号 → 关网关 + 杀掉运行时 → 新网关第二轮日志
    `已载入 1 条会话足迹` → `已用 session/load 还原会话 0388ef48…` → 模型答出 `PINEAPPLE-7788`。
- 用量账本多记一个 `model` 字段，方便以后按模型汇总。
- `TODO.md` 重写为「结论清单」：额度显示写明证据与「明确不做」的原因
  （只有 `v1internal:retrieveUserQuota` 这类私有接口能拿到真额度，不做；估算额度会误导，也不做）。
- 自测：26 个离线用例 + 17 个 HTTP 行为用例全过（新增 session-store 2 例、
- 自测：26 个离线用例 + 18 个 HTTP 行为用例全过（新增 session-store 2 例、
  「重启还原」「load 失败回落新建」「运行时崩溃后按需拉起」3 个行为用例）。
- **修复：运行时被外部杀掉 / 崩溃后不会自己回来。** 旧实现只在启动时拉起一次，之后每一轮都返
  `502 ACP 运行时未启动`，必须手动重启网关才恢复（实测日志里连 8 条）。现在每个请求前确认一次
  `acp.status().running`，不在位就按需重新拉起（`AcpRuntime.start()` 本身单飞 + 幂等）。

## 2.0.6

- 面板「桥接提示层」**直接铺出内置文案**，可在窗口内原样修改；新增「恢复默认」按钮一键回填。
- 内置文案与代码共用同一份常量（`lib/config.js: BUILTIN_BRIDGE_GUIDANCE`），不会再出现
  “面板显示 A、实际生效 B”的漂移。
- 配置面板按 **服务与端点 / 模型与思考 / 工具与桥接 / 会话与超时 / 高级** 五组分区。

## 2.0.5

- **修复：新会话没有把完整上下文交给运行时。** 桥接模式此前只发“最后一条 user 文本”，
  于是 system 提示与 PI-Desktop 的全局 AGENTS.md 在新会话里根本到不了模型。
  现在新会话发 `flatten(messages)`（含 system / AGENTS.md / 历史），只有续会话才发增量。
  实测：带 `AGENTS-MARKER` 的 system 消息确实出现在 prompt 里。
- **提示层可编辑**：新增配置 `bridgeGuidance`（面板「桥接提示层（可改）」多行输入框）。
  留空用内置文案；填了就用你的，支持 `{tools}` 占位（替换为可用桥接工具名）。
  这意味着“先说再做”“失败两次换思路”这类要求现在由你控制，不必等我改代码。

## 2.0.4

- 工具循环中的“过程叙述”问题定位：日志显示每次挂起时运行时报来的正文都是 **0 字**，
  即它在工具循环里本来不说话（不是网关丢弃；2.0.3 已修的是网关丢弃那一半）。
- 提示层新增要求：调用工具前先用一两句话说明“要做什么、为什么”，工具返回后用一句话说明
  “从结果里得到了什么”，再决定下一步。让叙述来自模型，而不是网关合成假文本。
- 说明：若模型仍不遵守，界面就只有原生工具卡片 + 结束总结——这是运行时的行为，网关不会伪造正文。

## 2.0.3

- **修复：工具调用前的叙述文字被丢弃。** 挂起一轮时只发 `tool_calls`/`function_call`，
  运行时在这一轮已经说过的正文没有送出，表现为“上来就是几十个工具调用、最后才说话”。
  现在 `park` 会先冲掉累计正文（Chat 作为 content 增量、Responses 作为 message 输出项），再发工具调用。
- 冲掉后清空累计正文，避免续流时重复。
- 验证：Chat 与 Responses 的闭环脚本都断言“第一轮包含叙述且包含工具调用”，单元 24/24、行为 15/15。

## 2.0.2

- **重构：桥接状态机只保留一份**（`lib/bridge-turn.js`）。会话/挂起/回填/续流/提示层引导统一实现，
  Chat 与 Responses 只保留各自的协议适配层（`begin/text/thought/park/finish/error/end`）。
  此前两份实现已经出现“续流绑错 SSE”这类同源缺陷，现在从结构上消除。
- 续流事件由核心统一发给**当前轮**的适配器，两个通道行为一致。
- 无行为变更：单元 24/24、行为 15/15，Chat 与 Responses 的独立闭环脚本均通过。

## 2.0.1

- 修复 Responses 桥接**完全没有 usage**：`envelope()` 现在带上 `input/output/total_tokens`
  与 `context_used/context_size`，宿主才能算上下文占比；此前该通道的计量是空的。
- 首个工具轮（挂起那一轮）也会带计量，并在日志打印「本轮计量 输入/输出」。
- 说明：宿主对 Responses 只在终止事件读取 usage，所以该通道**没有逐字速度**；
  需要实时 tokens/s 时请把端点协议设为 chat completions（该通道每个 chunk 都带 usage）。

## 2.0.0

- **两个通道都接桥接**：新增 Responses 通道的 `responsesBridged`，运行时工具调用发成
  `response.output_item.*(type=function_call)`，宿主执行后由 `function_call_output` 回填继续。
- **默认只走新后端**：分流条件改为 `bridgeTools !== false`；桥接启动失败时返回 502 并提示
  “如需改用运行时自带工具，请在面板关闭「工具回交」”，不再静默降级到旧通道。
- 修复：续流事件此前固定写到第一轮的 SSE（Responses 通道下表现为“工具执行完就没下文”）。
  现在每轮把 `bridge.emit` 指向当前请求的流。
- 回归：单元 24/24、行为 15/15；另附独立复现 `test/repro-responses-bridge.js`（Responses 闭环）。

## 1.9.1

- 修复：桥接开启时若复用「创建时未挂载 MCP」的旧会话，运行时会看不到 `pi-bridge` 工具（表现为子代理又调不到）。
  现在会话记录 `bridgeUrl`，与当前桥接地址不一致就关闭重建；`session/resume` 不会补挂 MCP。
- 新增回归用例：无工具请求建立会话后，带工具请求必须新建会话并关闭旧的。

## 1.9.0

**工具回交正式可用**：模型现在调用的是 PI-Desktop 自己的工具。

- 运行时通过回环 MCP（`pi-bridge`）看到宿主工具目录；调用时网关挂起、以 `tool_calls` 结束这一轮，
  由宿主用自己的工具循环执行（原生卡片、权限、hooks 全部生效），结果再回填给运行时继续。
- 实测：`pi-bridge` 的 `Bash`/`Glob`/`Read`/`Grep`/`TaskList` 全部走宿主；`Task` 可正常委派
  `nuaa-zxh` 与 `local-free` 子代理并拿回结果。
- 面板新增「工具回交（实验）」开关，**默认开启**；桥接自身起不来时自动回退普通路径，不影响日常对话。
- 修复配置归一化丢失 `bridgeTools` 的问题（此前即使配置文件为 `true`，运行中也永远不生效）。
- 提示层加入引导：明确要求优先使用 `pi-bridge_*` 工具，不要用运行时自带的 `view_file`/`run_command`/`invoke_subagent`。

**端点方式改回自定义配置**（更自由）：

- 移除 manifest 的 `contributes.providers` 与 `provider.register` 权限。
  插件不再生成只读的服务行，改为由你在「模型配置 → 添加服务」里自填 `http://127.0.0.1:41910/v1`，
  地址、模型、密钥都由你掌握。工具回交与端点方式无关，两种接入都能用。

验证：单元 24/24、行为 14/14（含完整桥接闭环）。

## 1.8.0

**工具回交（实验，默认关闭）**：工具调用不再由运行时自己执行，而是交给 PI-Desktop 执行。

- 新增回环 MCP 服务（`lib/mcp.js`）：`initialize`/`tools/list`/`tools/call`。
  `tools/call` **先发 SSE 响应头再等待**——运行时的 HTTP 客户端约 60 秒无头就会放弃。
- 新增桥接状态机（`lib/bridge.js`）：宿主工具目录 → MCP；运行时调用 → 挂起 → 以
  `tool_calls` 结束这一轮 → 宿主用自己的工具循环执行 → 结果回到下一轮 → 回填 → 运行时继续。
- `session/new` 与 `session/resume` 现在携带 `mcpServers`：
  `{ type: 'http', name: 'pi-bridge', url, headers: [] }`。
- `normalizeMessages` 保留 `tool_call_id`，否则工具结果无法配对回挂起的调用。
- 面板新增「工具回交（实验）」开关（`bridgeTools`，默认关闭）。关闭时行为与 1.7.0 完全一致。

实测：
- 直连探针证明 1.3.0 运行时接受该 MCP 形状，会 `tools/list` 并 `tools/call`（工具名带 `pi-bridge_` 前缀）。
- 端到端用例：运行时调工具 → 网关发 `tool_calls` → 宿主回填 → 运行时继续输出。
- 单元 24/24、行为 14/14。

限制（诚实记录）：
- 仅实现了 Chat Completions 通道；Responses 通道仍是旧行为。
- 长调用（>60 秒）目前只靠 SSE 注释帧保活，尚未实现轮询取回。
- 运行时仍自带 `view_file`/`run_command`，需要在提示层引导它优先用桥接工具，否则可能不用。

## 1.7.0

模型不再需要手工「添加 AI 服务」：插件用 manifest 的 `contributes.providers` 直接提供 provider。

- 服务行由插件持有（宿主设计如此：地址与模型只读，唯一可改是 API Key），
  但**可调项在对话层**——推理档位跟随模型声明的 `thinkingLevels`。
- 逐模型声明 `contextWindow 1048576`、`maxTokens 131072`、图片/文档能力、
  `supportsReasoningEffort`、`thinkingLevels: low/medium/high`、默认 `medium`。
  这正是旧版「什么都调不了」缺的东西。
- 走 `chat_completions`：宿主的 Responses 解析器只在终止事件读 usage，
  chat 通道才能让上下文用量随流更新。
- 网关默认端口 41910：改端口会让这条声明失效，需同时改 manifest（已在文档注明）。

实测：同形状探针插件在 0.22.0 上成功出现在模型选择器，推理档可选 omit/low/medium/high，
上下文显示 1.05M。回归测试新增 manifest 元数据断言。

## 1.6.0

生态融合第一批（详见 FUSION.md，来源均为 MIT 公开项目）：

- **解锁第三方模型**：新增 `clientName` 配置，透传到 ACP `initialize.clientInfo.name`。
  上游 1.3.0 只在该名字为 Zed / Xcode / JetBrains 时提供 Claude 与 GPT-OSS。
  实测同一运行时：默认名 9 个模型；填 `Zed` 后 12 个，新增 `claude-sonnet-4-6`、
  `claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。面板可填，留空保持原名。
- **后台子任务不再被误杀**：上游把 `invoke_subagent` / `schedule` 放到后台执行时不发任何 stdout，
  旧版看门狗会把合法长任务当卡死并取消。现在识别这类工具，运行期间不发 `session/cancel`，
  改为周期性输出"后台子任务仍在运行"，并保留 30 分钟硬上限兜底。

验证：21/21 单元/集成、13/13 HTTP/SSE 行为测试（新增后台子任务用例）；模型解锁已用只读探针对比确认。

## 1.5.13

「思考」栏里的工具进度不再是一墙重复命令：

- 同一次工具调用只报一行（以前 `tool_call` 和 `tool_call_update` 都发）
- 剥掉运行时标题里的 `[Codex] •` 前缀，以及重复的动作名（`运行命令: 运行命令: …`）
- 命令截断到 48 字，失败单独一行 `✖ 失败：…`
- 无论 Responses 还是 Chat Completions 都走同一套格式化

**为什么不能显示成真正的工具卡片（宿主限制，已核实）**：

- 宿主对 `function_call` / `custom_tool_call` 输出项会**真的执行**，未注册的工具名报 `TOOL_NOT_FOUND`，
  且要求配对工具结果。运行时的工具是它自己执行的，宿主再执行一次会重复副作用，所以不能这么发。
- `web_search_call` 是唯一「只展示不执行」的卡片，但语义被硬绑成联网搜索，不能拿来冒充读文件/跑命令。
- 宿主 assistant 内容块只有 `text` / `thinking` / `toolCall` / `hostedSearch` 四种，没有通用只读卡片通道。

## 1.5.12

**根因（已用原始 ACP 探针证实）**：agent 发来的请求与客户端收到的响应共用同一个 id 数字空间。
运行时的 `session/request_permission` 从 id 0 开始递增，而我们的 `session/prompt` 通常是 id 4、5……
旧代码只按 id 匹配在途请求，一旦相同就把**权限请求当成 prompt 的返回值** `resolve(undefined)`：

- 该轮正文 0、`stopReason` 丢失（日志里就是 `stopReason=(missing)`）
- 那条权限请求再也没人回答，运行时从此阻塞 → 下一轮 180 秒零事件
- 探针复现：只读文件的任务（不需要权限）12 次全部成功；写文件任务到第 5 次权限即「空回合」，随后追问挂死

修复与调整：

- 只有**没有 `method` 字段**的报文才算响应；带 `method` 的一律按请求答复
- 取消后宽限 20 秒仍无回复，就放弃这次 RPC 并丢弃该会话，不再把串行锁挂到硬超时
- 空回合改为**同一会话**催答（最多 2 次，90 秒静默上限）：保留上下文与工具结果，不换会话、不重放副作用
- 新增 transport 回归测试（id 撞车）+ HTTP 行为测试（同会话催答）

验证：21/21 单元/集成、10/10 HTTP 行为测试；直连 ACP 探针（8 次写文件 + 8 次权限）拿到完整正文、
`stopReason=end_turn`、8 个文件全部创建、结果后无迟到事件。
安装后在宿主里跑 geminitest 十二步读取验收：**12/12 通过，SUM=68012**，单轮 `stopReason=end_turn`、正文 1959 字、
13 次工具，没有触发催答、也没有换会话。同一任务在 1.5.10/1.5.11 上是空答 + 180 秒停滞。

## 1.5.11

- 修复正文计数误放在 tool_call 分支导致的错误截断判断；删除自动关闭会话、仅凭工具标题换会话重放的逻辑。空答明确报错，不自动重复工具操作。
- 上下文占用按会话保存，不再使用全局兜底；输出 token 仍是估算，不标成精确计量。
- 保留流式工具进度的最终内容，对齐 Responses output_index；中断用 response.incomplete 收尾。
- 已断开的排队请求不再执行，也不取消其他请求拥有的 prompt。
- 修复 port 变量缺失，纠正 HTTP requestTimeout 的含义和初始化位置。
- Chat Completions 增加流中 usage；检查到的宿主 Responses 解析器只在终止事件读取 usage，因此尚不能实现该路径的实时占用刷新。
- 新增 9 项 HTTP/SSE 行为测试；原有 20 项测试通过。真实宿主验收另行记录，不能用离线测试代替。

**历史结论更正：** 下方旧版本关于“运行时步数上限”“从不发送思考”“百分比已修好”等绝对结论未获充分验证。尤其正文计数缺陷使旧版截断日志失去证明力；以 AUDIT-STREAMING.md 的证据和剩余限制为准。

## 1.5.8

上下文百分比不再因为「本轮没有 usage_update」而掉到 0%：

- 截图证据：面板显示 `输入 56 输出 781`——56 是「按文本估算」，说明这一轮运行时根本没发 `usage_update`，
  于是我退回了估算值，宿主把 56/1M 显示成 0%
- 现在：记住最近一次运行时上报的真实占用（`lastKnownContext`），本轮没有新数据就沿用它
- 这样即使某些轮次（例如续跑后的新会话首轮）拿不到 `usage_update`，百分比也不会归零

## 1.5.7

修好「上下文永远清零 / 每轮新会话」：

- 日志证实宿主**确实传**了稳定会话键：`responses 请求标识：… cache=5baed1b2-7b01-489e-9a61-…`
  （即 `prompt_cache_key`），所以 `keyFor` 本来就能复用——问题在续跑
- 真因：续跑换新会话时我把这条对话的映射**删掉却没重绑**，于是本轮修完、下一轮又找不到会话，
  上下文从零开始，宿主百分比只能停在 0–2%
- 现在：换新会话后把原会话键重新绑到新 `sessionId`，对话连续性得以保留
- 附带：诊断日志第一段误打了 Node 的 HTTP 请求对象键（`_events,_readableState,…`），
  下一版会把它改成只打可疑字段

## 1.5.6

「思考」面板里的文案收拾干净（那不是真思考，是我合成的工具进度）：

- 明确一点：运行时**从不发送** `agent_thought_chunk`（低/中/高档实测都是 0 字），
  所以「思考」里能出现的只有我合成的进度行。真正的答案在下面的正文气泡里
- 进度行改成可读动作：`运行命令 / 读文件 / 写文件 / 联网搜索 / 抓网页 / 子任务`，
  后面跟截断到 60 字的标题；不再把整条 PowerShell 命令原样倒进「思考」
- 去掉 `· 工具` 这种兜底词重复（`tool_call_update` 没有标题时不再刷一行）


## 1.5.5

诊断版：定位「上下文统计不动 / 每轮都新会话」。

- 日志新增 `chat/responses 请求标识：…`，把宿主请求里所有可能当会话标识的字段打出来
  （`body` 键集合、`prompt_cache_key`、`previous_response_id`、`metadata.conversation_id`、
  `x-session-id`、`x-conversation-id`）
- 背景：日志显示每一轮都是「新会话」，上下文因此每轮清零（实测 `上下文占用 26,910/1,048,576` ≈ 2.6%，
  宿主显示 0–2%）。若宿主确实不传稳定标识，就只能靠这行日志确认，再决定是改用
  「system + 首条 user」以外的启发式，还是要求宿主透传会话 id
- 无行为变更（除多一行日志）

## 1.5.4

`/v1/responses` 里终于能看到「思考 / 工具进度」：

- 根因：宿主（`openai-responses-shared` 474–486 行）只在收到
  `response.output_item.added`（`item.type = reasoning`）后，才会为
  `response.reasoning_summary_text.delta` 建「思考」槽位。我之前把工具进度写成了 SSE 注释帧，
  宿主直接丢弃——所以界面上什么都看不到
- 现在：`agent_thought_chunk` 与每次工具调用都以 reasoning 事件下发
  （`reasoning_summary_part.added` → `reasoning_summary_text.delta` → `…part.done` → `output_item.done`），
  正文仍是独立的 `output_item.added(type=message)`，两者不互相污染
- 实测帧序列：`created, in_progress, output_item.added, reasoning_summary_part.added,
  reasoning_summary_text.delta ×8, content_part.added, output_text.delta, …, completed`，
  delta 内容形如 `· echo REASON-OK`
- 顺带说明：`/v1/chat/completions` 走的是 `reasoning_content` 字段（宿主
  `openai-completions` 168 行），本来就可见；两条路径现在都能看到进度

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
