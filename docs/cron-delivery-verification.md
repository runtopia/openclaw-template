# OneClaw Cron 投递验收

在部署包含本次 Channel 诊断日志的镜像后，在 Runtime 日志中搜索 `[oneclaw-cron]`。插件包仍使用 develop 的内容寻址版本；不能仅凭 npm 版本号判断代码是否更新。

## 1. 确认新规则已加载

启动应出现：

```text
[oneclaw-cron] creation_policy_ready policy=isolated-agentTurn-announce-v3
```

它只证明 Channel 创建规则已加载，不代表某个任务已创建或已投递。

## 2. 从 App 新建测试任务

在目标 App 会话中请求“两分钟后提醒我喝水”。新建任务时首先应出现 `tool_call_seen`（包含 action、channelId、sessionKey、toolCallId 和 jobShape），随后才是 `create_normalized`。入口日志不打印原始参数或任务正文。

- 有 `cron.add` 成功，但完全没有 `tool_call_seen`：继续检查该次调用是否经过原生工具 Hook；不能据此认定规则生效。
- 有 `tool_call_seen`，却没有 `create_normalized`：核对 channelId、sessionKey，以及是否出现 `create_blocked`。非 OneClaw 创建入口不做归一化。
- 有 `create_normalized`：还需核对实际保存配置和最终投递。

归一化日志示例：

```text
[oneclaw-cron] create_normalized {"toolCallId":"...","originalKind":"systemEvent","payloadKind":"agentTurn","sessionTarget":"isolated","deliveryMode":"announce","deliveryChannel":"oneclaw","deliveryTo":"session_...","toolsAllowCount":0}
```

`originalKind` 也可能为 `agentTurn`；重点检查后面五个类型与投递字段。`deliveryTo` 必须是创建任务的来源 Session。此日志发生在 native cron 工具执行前，只证明参数已归一化；随后还需确认工具成功，并在 Cron 详情或 `cron.list` 中核对实际保存的配置。

旧任务不会自动修改。旧 `systemEvent` 任务不能用于判断新建规则是否生效；确认旧任务停用或删除后，从 App 重新创建，避免重复提醒。

## 3. 确认执行阶段绑定

任务触发时应出现：

```text
[oneclaw-cron] run_delivery_bound {"jobId":"...","runAtMs":1789108774410,"deliveryTo":"session_..."}
```

用 `jobId` 与任务详情对应；`runAtMs` 区分同一周期任务的不同运行。该日志证明执行阶段找到了 OneClaw 投递路由，不代表 API 已接收或 App 已显示。

## 4. 确认端到端结果

检查运行历史中的执行状态和投递状态，并在 App 中确认实际提醒消息。周期任务至少连续验证两次。若执行失败，继续看模型/工具错误；若执行成功而投递失败，继续看 OneClaw API/Channel 的错误；若 API 已接收但 App 没显示，继续检查客户端同步。系统通知还受 App 通知权限等因素影响，需与会话消息分开验收。

这些日志不输出提醒正文、提示词或鉴权凭据。创建参数日志与运行绑定日志使用 JSON 编码，Session ID 用于排查路由。

## 验证稳定性

不能以 develop 一次投递成功代替生产问题验收。应在相同修复镜像中分别验证标准 `job`、扁平参数、`job.data` / `job.job`、省略 payload.kind 的文本提醒；显式 `systemEvent + main + delivery:none` 也必须归一化。仓库回归测试会再经过当前 OpenClaw 的真实参数恢复函数，防止它覆盖 Hook 的结果。2026-09-11 16:28 的现场日志已确认原生 Hook 的 `channelId` 为 `oneclaw:session_...`，此前精确匹配 `oneclaw` 的判断误跳过了该调用。v3 同时识别纯渠道 ID 和完整 OneClaw Session 地址，投递目标仍从可信运行/Session 上下文解析，不能仅使用模型参数。
