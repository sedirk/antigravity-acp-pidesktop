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

## 配置只有一处

面板写入插件数据目录的 `config.json`，**这是唯一配置来源**；不要手改文件。
旧版本放在插件根目录的 `config.json` 只在首次加载时迁移一次，之后不再读取。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 41910 | 本地网关端口 |
| `proxy` | 空 | 注入给 ACP 子进程的代理，如 `http://127.0.0.1:10808` |
| `concurrency` | 0 | 0 = 不限制；1 = 串行；2–8 = 并行上限 |
| `queueTimeoutMs` | 300000 | 排队等待上限 |
| `virtualModels` | true | 按档位后缀合并模型 |
| `exposeVariantModels` | false | 是否同时列出带档位后缀的显式模型 |

## 已知边界

- 只保证 Windows 的自动下载；其他平台请手动放置运行时并填 `bin` 路径
- 只做聊天与文本输入，未映射工具调用（ACP 的 tool_call 事件目前忽略）
- 思考内容（`agent_thought_chunk`）已接入 `reasoning_content` / `reasoning` item，
  但实际是否出现取决于模型与档位
- 额度、限流与条款解释权在 Google 侧；请不要多账号轮换或当高并发后端使用

## 开发

```powershell
node test/run-tests.js
```

覆盖配置单源与迁移、并发限制（不限/串行/超时/队满）、模型分组与 `reasoning_effort` 解析、
两种请求体归一化。测试不联网、不启动运行时。

## 许可与来源

本插件原创代码使用 AGPL-3.0（见 `LICENSE`）。

运行时不属于本仓库：它由 Google 发布在
`https://dl.google.com/agy-extensions/releases/...`，插件只提供下载与校验，不再分发。
ACP 协议见 <https://github.com/agentclientprotocol/agent-client-protocol>。
