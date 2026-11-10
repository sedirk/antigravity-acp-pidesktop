# Antigravity ACP · PI-Desktop 插件

把 **Google 官方 Antigravity ACP 运行时**（`agy_acp_server.exe`）接成 PI-Desktop 里可用的
OpenAI 兼容本地网关。

> 它不是 sub2api：本插件**不抓 token、不逆向 Google 私有接口**。凭据由官方二进制自己登录、
> 自己保管（`~/.gemini/antigravity-acp/`），插件只用 stdio 说 ACP 协议。

## 它做什么

- 在本机 `127.0.0.1` 暴露 `POST /v1/chat/completions`、`POST /v1/responses`、`GET /v1/models`
- **虚拟模型**：把 ACP 的 `xxx-low/-medium/-high` 自动合并成 `xxx`，思考档位由请求里的
  `reasoning_effort` 决定（新模型上线只要还带档位后缀就会自动出现，不用改代码）
- 给运行时子进程按需注入 `HTTP(S)_PROXY`，不影响系统代理
- **可选并发限制**（默认关闭）：设成 1 即串行，其余请求排队，带排队超时与队满拒绝
- 面板一键下载官方运行时并做 SHA256 校验
- **图片输入**（0.4.0 起）：`image_url` / `input_image` 的 `data:` URL 与 `http(s)` 链接都会转成 ACP 的
  `image` 内容块随同一条 prompt 发出；模型没图时会直说收不到，所以「答非所问」不会再被误判为配额问题
- 图片输入需要宿主端把该模型标成支持图片（vision）：PI-Desktop 只在模型带 vision 能力时才会把附件放进请求体

## 安装与配置

1. 插件页安装后打开命令「Antigravity: 打开配置面板」
2. 点「下载官方运行时」（约 120 MB，走你填的代理；SHA256 会对官方清单校验）
   - 首次加载若还没安装运行时，插件会主动弹提示，不需要先读 README
   - 面板实时显示百分比、已下载/总量、速度；校验与解压各自有状态，完成后有提示
3. 首次使用需登录：在终端跑一次运行时并完成 Google 登录，或先在本机 Antigravity 里登录

   ```powershell
   & "$env:USERPROFILE\.pi-desktop\plugins\data\local.antigravity-acp\runtime\agy_acp_server.exe"
   ```

   登录完成后凭据保存在 `~/.gemini/antigravity-acp/`，插件不会读取它。
4. 在 PI-Desktop「设置 → AI 服务 → 自定义端点」填 `http://127.0.0.1:41910/v1`，
   认证留空，接口格式选 Chat Completions 或 Responses，然后「获取模型列表」

## 配置只有一处

面板写入插件数据目录的 `config.json`，**这是唯一配置来源**；不要手改文件。
旧版本放在插件根目录的 `config.json` 只在首次加载时迁移一次，之后不再读取。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 41910 | 本地网关端口 |
| `proxyMode` | `auto` | `auto` 跟随系统代理 / `manual` 用下面填的地址 / `direct` 直连 |
| `defaultEffort` | 空 | 请求没带 `reasoning_effort` 时使用的档位（low/medium/high）；空 = 模型默认 medium |
| `proxy` | 空 | 手动模式的代理地址，如 `http://127.0.0.1:10808` |
| `concurrency` | 0 | 0 = 不限制；1 = 串行；2–8 = 并行上限 |
| `queueTimeoutMs` | 300000 | 排队等待上限 |
| `virtualModels` | true | 按档位后缀合并模型 |
| `exposeVariantModels` | false | 是否同时列出带档位后缀的显式模型 |

## 参数透传：哪些生效、哪些被运行时忽略

ACP 的 `session/prompt` 只接受内容块，**没有任何采样参数位**；思考档位是编码在模型 ID 后缀里的
（`-low` / `-medium` / `-high`），所以「思考强度」靠换模型实现，而不是传 `thinking` 对象。
下表是实测结论（官方运行时 1.3.0，真实请求验证，不是文档推断）：

| 请求字段 | 结果 | 说明 |
| --- | --- | --- |
| `reasoning_effort` | ✅ 生效 | `low`/`minimal`→`-low`，`high`/`xhigh`/`max`→`-high`，缺省或其它→`-medium`；日志会打印 `chat gemini-3.8-flash → gemini-3.8-flash-low（effort=low）` |
| 模型 ID 带档位后缀 | ✅ 生效 | 例如直接写 `gemini-3.8-flash-high`，按后缀选 |
| `image_url` / `input_image` | ✅ 生效 | `data:` URL 与 `http(s)` 链接都转成 ACP 的 `image` 块（0.4.0 起） |
| `stream` | ✅ 生效 | SSE 流式 |
| `temperature`、`top_p`、`top_k`、`max_tokens`、`max_completion_tokens`、`stop`、`seed`、`presence_penalty`、`frequency_penalty`、`logprobs`、`top_logprobs`、`logit_bias`、`response_format`、`text.format`、`verbosity` | ❌ 被忽略 | 实测 `max_tokens=8` 仍输出 229 字；发给运行时也不报错，属于静默丢弃，网关会在日志里打印一行「运行时忽略 …」 |
| `tools`、`tool_choice`、`parallel_tool_calls` | ❌ 未映射 | ACP 的 `tool_call` 事件目前不处理；`session/set_mode`（default/auto_edit/yolo）存在但网关未暴露 |
| 思考内容（`agent_thought_chunk`） | ⚠️ 通道已接好，但运行时不发 | 实测 carbon/argon/3.8-flash × low/high 四组，思考块都是 0 字：能改档位，读不到思维过程 |
| `usage` | ✅ 估算值 | ACP 不返回 token 数，按「CJK 每字 1 token、其余 4 字符 1 token」估算，并带 `estimated: true` |

`GET /v1/models` 会顺带声明能力：`modalities.input = [text, image]`、`capabilities = [text, image, reasoning]`、
`supports_reasoning_effort = true`、`reasoning_efforts = [low, medium, high]`，
方便宿主判断「能不能发图」「要不要发 reasoning_effort」。

## 已知边界

- 只保证 Windows 的自动下载；其他平台请手动放置运行时并填 `bin` 路径
- **卸载插件不会删除运行时**（约 227 MB）。运行时放在插件数据目录 `plugins\data\local.antigravity-acp\runtime\`，
  卸载前请先执行命令「Antigravity: 清理已下载的运行时」，或在面板点「清理运行时」释放空间
- 退出时会用 `taskkill /T` 结束整棵进程树；插件启动时还会清掉「父进程已退出」的残留运行时，
  避免多个 ACP 实例共享同一账号额度导致偶发超时
- 下载过程中面板会显示百分比、已下载/总量、速度；校验、解压各有独立状态，完成后有提示
- 只做文本 + 图片输入，未映射工具调用（ACP 的 tool_call 事件目前忽略）
- 模型切换（`session/set_model`）失败时会重试一次，仍失败则直接报错，**不会用会话默认模型代替**回答
- 思考内容（`agent_thought_chunk`）已接入 `reasoning_content` / `reasoning` item，
  但实际是否出现取决于模型与档位
- 额度、限流与条款解释权在 Google 侧；请不要多账号轮换或当高并发后端使用

## 开发

```powershell
node test/run-tests.js
```

覆盖配置单源与迁移、并发限制（不限/串行/超时/队满）、模型分组与 `reasoning_effort` 解析、
两种请求体归一化、图片块转换。测试不联网、不启动运行时。

## 许可与来源

本插件原创代码使用 AGPL-3.0（见 `LICENSE`）。

运行时不属于本仓库：它由 Google 发布在
`https://dl.google.com/agy-extensions/releases/...`，插件只提供下载与校验，不再分发。
ACP 协议见 <https://github.com/agentclientprotocol/agent-client-protocol>。
