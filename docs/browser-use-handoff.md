# Browser Use：人工接管与交还（develop 测试版）

基于已提交的只读浏览器版本。独立 OpenClaw 插件 `oneclaw-browser-use` 位于 oneclaw-plugins 仓库；不修改 OpenClaw 核心，也不依赖聊天客户端或 OneClaw Channel 在线。

## 开启方式

- 插件通过内容寻址本地 `.tgz` 锁定在 `resources/openclaw-plugin-bundle`，构建时安装到 `/opt/openclaw-plugins/node_modules/@oneclaw-plugins/browser-use`，不需要目录挂载或 npm 发布。
- 新镜像默认设置 `ONECLAW_BROWSER_USE_ENABLED=1`，与 `ONECLAW_BROWSER_ENABLED=1` 一起启用；实例环境中已有的覆盖值需自行检查。
- 插件目录可通过 `ONECLAW_BROWSER_USE_PLUGIN_DIR` 指定。目录需归 root 或 Runtime 用户所有，不能可被其他用户任意修改。
- 未开启新开关时仍为只读预览。历史提交 `e1eeba6` 仅包含只读预览。
- 101 的独立开发实例为 `oneclaw-browser-use-dev`，端口 18084；18083 是原只读演示。开发实例使用过叠加源码的验收镜像；现在 develop 的部署镜像统一使用锁定本地 tar 包。

## 状态与边界

`ai → waiting → human → ai`，断线或重启进入 `paused`。

1. 点击“接管浏览器”先关闭新的受管 AI 操作入口，等待在途操作结束。
2. 排空后启动独立的可写 VNC 服务（loopback 5901），仅允许拥有控制凭证的一个 WebSocket 客户端连接。其他观看者继续使用只读 5900。
3. 交还时断开输入连接，等待可写 VNC 进程退出；超时先强制回收，若仍不能确认退出则不放行 AI。
4. 交还后原生 browser 的修改操作必须先有一次成功的新 snapshot，不允许直接复用旧引用。
5. 断线保持暂停。原控制页面可“继续接管”或“交还 AI”；凭证丢失后，可在已鉴权页面明确点击“恢复 AI 控制”。存在未完成操作时不能强制恢复。

控制凭证保存在当前页面的 sessionStorage；服务端只持久化哈希。所有外部 API 仍需 Runtime 登录鉴权，修改操作与 WebSocket 还需同源 Origin。
控制状态由 Gateway 插件统一维护，存储于 `$OPENCLAW_STATE_DIR/browser-use/control.json`。Wrapper 只管理输入传输和客户端连接，不单独放行 AI。

## 这一版没有承诺的能力

- 不是整个 Agent 任务的自动暂停/恢复。拦截工具后，模型可能结束当前回复；交还后已结束的对话仍需要用户发送“继续”。尚未接入 Channel 的任务恢复流程。
- 拦截范围是正常 Agent run 的 `browser`、`exec`、`process`、`gateway`、`nodes`。后台 exec 返回 running 时保留占用，等待同一会话的 process poll 确认完成。
- 直接管理员 `browser.request`、CLI/CDP、其他浏览器 MCP 工具，以及脱离受管工具生命周期的脚本，不受此互斥约束；不把插件钩子宣称为任意代码执行的安全隔离。
- 固定版本 `tools.invoke` 只有前置钩子、缺少完整后置生命周期；无 runId 的受管调用明确拒绝，避免占用泄漏后错误交权。
- 缺失完成钩子或崩溃留下的占用不会按时间自动删除。需要运维确认旧操作已终止后处理状态；页面不能忽略占用强行接管。
- 101 的 Fake-IP DNS 与 sandbox 条件沿用只读版说明，测试实例仍使用占位模型密钥。

## 验证

- 插件包：`node --test plugins/oneclaw-browser-use/test/*.test.mjs`。
- Wrapper：`node --test`。
- 独立测试容器：`node /app/scripts/verify-browser-handoff.mjs`，验证排空、排他、启动拦截、凭证校验、输入关闭与交还。
- 实际页面验证接管后的鼠标输入，并在断线/交还时确认可写连接关闭。

更新测试包：先将插件源代码合入并推送插件仓库 develop，再执行 `npm run update:local-browser-use`。脚本要求插件仓库干净且与 origin/develop 同步；生成的归档包含完整 SHA-256，不覆盖同名包内容。

如需彻底关闭接管，除 `ONECLAW_BROWSER_USE_ENABLED=0` 外，也应将已有配置中的 `plugins.entries.oneclaw-browser-use.enabled` 设为 false，避免旧插件设置继续生效。

## Agent 使用指南

插件内置 `skills/browser-use/SKILL.md` 并通过 manifest 声明发现路径；指南随本地 tar 包一起更新。每轮短提示指明原生 browser、openclaw/host、有界面与 :99 约定。工具钩子补齐缺省 profile/target，并拒绝无头启动及其他控制面。Gateway spawn 环境强制 DISPLAY=:99、OPENCLAW_BROWSER_HEADLESS=0。任意 exec 脚本仍不属于完整隔离边界。

正常情况下复用一个 Chromium 进程，可开多个标签页。断开 VNC 不会停止浏览器；人工接管连接断开会保持控制权暂停。OpenClaw 的任务标签页清理、主动 stop、进程退出或容器重启可能关闭页面。持久化 profile 保留站点数据，不等于保证恢复所有历史标签页。

## 分享稳定入口

模型调用插件工具 `browser_use`，参数 `{"action":"share"}`，工具通过 Runtime 凭据向现有 `/runtime/personality` 查询可信的 Workspace 公共 ID，返回 `https://<平台域名>/browser-use/<workspaceId>`。工具不接受模型指定 Workspace/Runtime，不发送消息，不签发登录票据。模型原样发送链接，普通聊天文本仍通过现有 Channel 交付。

入口表示该 Workspace 当前共享浏览器，不是历史 Session 页面快照。Web 点击入口后，复用 Firebase 鉴权的 `POST /api/v1/workspace/runtime-sessions`，传 `workspace_id` 和 `next:"/browser/"`；Go API 校验所有权后即时获取 Runtime 一次性票据。没有新增匿名访问能力。

- Runtime：优先复用已鉴权 API 返回的 `app_url`（平台已有 `NEXT_PUBLIC_APP_URL` / `External.app_url`）；`ONECLAW_BROWSER_USE_WEB_URL` 仅作显式覆盖。测试 API 缺少 Web 地址时明确报错，不猜测生产域名。
- Web v2：`NEXT_PUBLIC_APP_URL` 设置为相同的公开 origin，以识别测试/自定义域名的卡片。生产域名 `https://www.oneclaw.net` 和 `https://oneclaw.net` 默认受支持。
- 地址必须是完整稳定 URL。客户端严格校验 origin 和 `/browser-use/<workspaceId>` 路径，无凭据、查询参数或 fragment 的普通入口才渲染卡片；其他链接保持普通超链接。
- 无平台 Runtime 凭据、无可信会话或身份查询失败时，工具返回错误，不能编造地址。

### 18081 故障修正

Channel/Integrations 会移除 process.env 中的实例密钥。分享工具应使用进程内共享凭据闭包，并兼容 ONECLAW_RUNTIME_ID，不能因为环境变量被清理就判断为非托管环境。平台 API 更新后会在 personality 中返回 app_url。

101 的无特权 Docker 容器无法创建 Chromium namespace sandbox；已为 18081 持久化 browser.noSandbox=true，仍保持 DISPLAY=:99 和 headless=false。同类新实例需显式配置 ONECLAW_BROWSER_NO_SANDBOX=1；不因此关闭 SSRF/导航保护。
