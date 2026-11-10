# 变更记录

## 1.0.0

界面与可观测性收口；不改变既有行为。

- `/health` 增加 `toolPolicy`、`sessions`、`lastRequest`
- 运行时退出 / 网关关闭时一并清空按会话的工具权限覆盖
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
