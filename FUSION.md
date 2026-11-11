# 生态融合记录

调研对象均为 npm 上公开的 MIT 项目，只吸收**设计与缺陷结论**，代码为重写实现（未逐行复制）。
来源与许可证列在文末，供溯源。

## 一、各家最优部分

### `@simonepri/refined-antigravity-acp`（MIT）—— 上游 ACP 缺陷修复集（最有价值）
它把 `agy_acp_server` 的已知缺陷逐条记录并给出修法，和我们踩过的坑一一对应：

| 上游缺陷 | 现象 | 我们的对应问题 |
|---|---|---|
| `premature-turn-stop` | 工具执行后以空补全（stopReason=16，无正文无工具）结束回合 | 空答 + `stopReason=(missing)`；1.5.12 用同会话催答覆盖 |
| `silent-background-tasks` | 子代理/定时任务后台运行时**不产生任何 stdout** | 看门狗把合法长任务当卡死，180 秒取消 |
| `dangling-tool-calls` | 不发送终态 `tool_call_update`，界面永久转圈 | 截图里的“失败/一直处理中” |
| `gated-third-party-models` | 仅当 `clientInfo.name` 是 Zed/Xcode/JetBrains 才提供 Claude、GPT-OSS | 我们只能看到 9 个 Gemini 模型 |
| `repetitive-tool-loop` | 模型陷入重复工具循环时上游不检测 | 截图里整墙重复命令 |
| `orphaned-checkpoints` | 取消后留下 status=2 检查点，恢复时 panic | 取消后同会话卡死 |
| `active-turn-collision` | 回合进行中再发 prompt 直接致命错误 | `receive_steps` 并发报错 |
| `cancellation-leak` | 取消时把 Go/Python 错误串写进正文 | 取消后出现乱码文本 |
| `malformed-stream-syntax` | 模型输出未转义 Mermaid/LaTeX、泄漏内部标签 | 渲染崩溃 |
| `missing-usage-metrics` | 某些版本完全不发 `usage_update` | 上下文百分比不动 |
| `stale-mcp-endpoints` | 进程回收后旧 MCP 端口失效 | 尚无 |

### `pi-antigravity-acp-provider`（zacbemis, MIT）
- 原生 provider 注册（`pi.registerProvider`），模型把档位折叠为一个条目。
- **回环 MCP 桥**：把 pi 的工具目录实时投影给 ACP 运行时，调用前再校验（不信任缓存目录）。
- 托管运行时：签名目录、精确哈希与体积、只解压两个文件、启用前校验 ACP 身份/版本、不可变发布、回滚。
- 权限模式 `default`/`auto-edit`/`yolo` 持久化。

### `@estebanforge/pi-antigravity-bridge`（MIT）
- **只读步骤复用 pi 内置工具**（`view_file→read`、`list_dir→ls`、`grep_search→grep`、`find_by_name→find`），因此卡片原生渲染。
- 变更类步骤不落到 pi 执行，走一个**仅展示**的 `antigravity` 包装工具，避免二次副作用。
- 长调用：超过上游 ~180 秒即返回 `STILL RUNNING` + `callId`，由 `bridge_poll_result` 轮询取回。
- 会话绑定持久化、引擎切换（acp / stream-json）。

### `omp-antigravity-acp-provider`（MIT，zacbemis 派生）
- `context-transfer.ts`：把 pi 的系统提示、工具定义与历史转成 ACP 侧可用的上下文（含 token 估算）。

### `pi-agy-acp`（MIT）
- `mcp-bridge.ts` 的紧凑实现（约 16 KB），适合作为最小桥接参考。

## 二、已吸收（1.6.0）

1. `gated-third-party-models`：新增 `clientName` 配置，透传到 ACP `initialize.clientInfo.name`。
   实测同一运行时：默认名 9 个模型；`Zed` 后 12 个，新增 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。
2. `silent-background-tasks`：识别 `invoke_subagent` / `schedule` 类后台工具；在它们未结束期间不发
   `session/cancel`，改为周期性输出“后台子任务仍在运行”，并设 30 分钟硬上限兜底。

## 三、待吸收（按价值排序）

1. 原生 provider + MCP 工具桥（zacbemis / estebanforge）：让工具调用成为 pi 原生调用，
   卡片原生显示、`Task` 子代理可被模型调用。这是“接入”而非“套皮”的关键一步。
2. `dangling-tool-calls`：回合结束/正文开始流式时补齐工具终态，消除永久转圈。
3. `repetitive-tool-loop`：按规范化签名检测连续重复，识别用户“轮询意图”后放行，其余情况注入纠偏提示。
4. `orphaned-checkpoints`：取消后清理未提交检查点，避免 resume 时 panic。
5. `active-turn-collision`：把回合中到达的输入排队重试，而不是直接失败。
6. `context-transfer`：把 pi 的上下文/系统提示转给运行时，替代现在“只发最新一句”的做法。

## 四、来源与许可证

| 包 | 版本 | 许可证 | 仓库 |
|---|---|---|---|
| `pi-antigravity-acp-provider` | 0.1.19 | MIT | github.com/zacbemis/pi-antigravity-acp-provider |
| `@estebanforge/pi-antigravity-bridge` | 1.10.4 | MIT | github.com/EstebanForge/pi-extensions |
| `@simonepri/refined-antigravity-acp` | 1.6.7 | MIT | npm: @simonepri/refined-antigravity-acp |
| `omp-antigravity-acp-provider` | 0.1.42 | MIT | npm: omp-antigravity-acp-provider |
| `pi-agy-acp` | 0.1.2 | MIT | npm: pi-agy-acp |

以上仅借鉴公开文档与源码中的**缺陷描述与算法思路**；本仓库实现为独立重写。
若后续直接内嵌其代码，将按其许可证保留版权与许可声明，并在 `THIRD_PARTY_NOTICES.md` 记录。

## 五、provider 声明路径（1.7.0 采纳）

调研结论（0.22.0 实测 + 宿主 i18n 源码）：

- `contributes.agentExtensions` 里 `registerProvider` 能登记，但模型不会进入模型选择器（本版未接通）。
- `contributes.providers` 会生成**插件持有**的服务行：`pluginProviderManaged` 文案明确
  「接口地址和模型均由该插件提供」，因此**服务行只读**，唯一可改项是 API Key。
- 可调项因此落在**对话层**：`thinkingLevels` 驱动 composer 的推理档，逐条消息生效。
  这正是 1.6.0 及更早「参数全都调不了」的成因——不是缺字段，而是位置不对。

采纳方案：manifest 声明 provider（3 个虚拟模型）+ chat_completions + 完整元数据；
网关把 `reasoning_effort` 映射到 ACP 的 `-low/-medium/-high` 模型档位。
