# 变更记录

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
