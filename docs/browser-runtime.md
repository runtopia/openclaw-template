# 同容器浏览器与实时预览

镜像使用 tini 作为 PID 1，转发退出信号并回收 Chromium 孤儿子进程。

标准镜像默认包含 Chromium、中文/Emoji 字体、Xvfb、Openbox、x11vnc、websockify 和 noVNC。
OpenClaw 原生 browser 工具负责 Chromium 的启动、标签页、操作和截图；Wrapper 只管理显示与预览服务。

## 使用

1. 使用新版镜像，继续挂载 `/data`，设置模型密钥和 `SETUP_PASSWORD`（或使用平台的 `ONECLAW_INSTANCE_SECRET` 登录票据）。
2. 登录 `/login`，打开 `/browser/`，点击“启动浏览器”；AI 调用原生 browser 工具也能启动。
3. 让 Agent 使用 `openclaw` profile、host 浏览器操作网页并截图。预览显示同一桌面的前台标签页；后台标签页操作不保证自动切至前台。
4. 原生截图是工具结果，需通过 OneClaw Channel 明确交付给用户。

平台可复用 `POST /repair/openclaw-login`，body 为 `{"next":"/browser/"}`，获取一次性登录链接。
第一版按新窗口/新标签打开，页面 CSP 仅允许同源嵌入；不提供跨站 iframe 嵌入。

**第一版为服务端强制只读**（x11vnc `-viewonly`），不提供人工输入、接管、自动暂停或录像。
登录、扫码、验证码中的人工输入场景尚未实现，不能用前端切换 viewOnly 来替代接管协调。

## 配置和持久化

- 构建参数 `ONECLAW_BROWSER_ENABLED=0`：省略浏览器依赖，默认是 `1`。
- 运行变量 `ONECLAW_BROWSER_ENABLED=0`：关闭显示服务和 Wrapper 浏览器配置补全，不删除用户已有的 OpenClaw 浏览器配置。
- `ONECLAW_BROWSER_NO_SANDBOX=1`：显式开启 OpenClaw 的 `browser.noSandbox`，仅用于宿主机无法提供 Chromium sandbox 的隔离 Runtime。
  默认不关闭 sandbox；该值写入配置后持久化，恢复 sandbox 需将 `browser.noSandbox` 改回 false。
- 显示环境固定 `DISPLAY=:99`、1440×900；Gateway 与 Chromium 继承该环境。
- 保留用户明确配置的 executablePath、headless、attachOnly、默认 profile 和禁用状态。
  若已有 headless/remote 配置，预览可能为空；预览启动按钮固定启动本地 `openclaw` profile。
- 在 coding profile 中补充 browser 工具；明确的工具 allow/deny 与插件禁用保留优先级。
- 固定 OpenClaw 2026.7.1-2 将托管 profile 写入 `${OPENCLAW_STATE_DIR}/browser/openclaw/user-data`，因此现有 `/data/.openclaw` 卷即可持久化 Cookie 等状态。
- 浏览器空闲时不由 Wrapper 主动启动；显示服务随 Wrapper 启动，失败后有限退避重试，不修改 Gateway 配置或重启 Gateway。

## 网络与边界

公网仍只需要 Wrapper 8080。VNC 5900 与 websockify 6080 仅监听 loopback，Xvfb 不开启 TCP。
`/browser/*` 需要配置凭据并通过现有登录鉴权，不继承无密码开发模式的匿名放行。
预览 WebSocket 与启动操作还要求同源 Origin；转发时剥离 Cookie/Authorization。
不要直接映射 5900、6080 或 Chromium CDP 端口。

Chromium 与 Gateway 共享容器内存限制。先用 4 GiB 作为实测起点，并监测复杂页面与多标签内存。
无 GPU 的网站、媒体与反自动化登录仍需逐站验证。

## 验收

- 未登录的页面不能观看；无凭据配置返回 503；跨站 WebSocket/POST 返回 403。
- `/browser/status` 为 ready，预览收到 VNC 画面。
- `openclaw browser --browser-profile openclaw start/open/snapshot/screenshot` 成功。
- 原生截图与 VNC 桌面展示同一个网页。
- 重启同一容器后 profile 内站点存储保留。
- 显示服务异常恢复不触发 Gateway 重启。

修改 browser 插件启用状态应在下次部署启动前完成；不添加普通配置变更后的 Gateway 重启。

测试实例可将 `scripts/verify-browser-runtime.mjs` 放入容器 `/app/scripts/`，执行
`docker exec -u openclaw <container> node /app/scripts/verify-browser-runtime.mjs`。
脚本会打开 example.com，在页面中插入明确标识的验证面板，用原生快照引用点击按钮、聚焦并截图，
同时写入测试用 localStorage。重启后增加 `--verify-persistence` 可验证该标记是否保留。
该测试不调用模型，不需要真实 LLM API 密钥，不应在用户正在操作的浏览器中执行。

## 101 测试环境记录

2026-09-23 在 `codoon@192.168.1.101` 构建验证，独立实例为 `oneclaw-browser-preview`，对外端口 18083。
该宿主机默认容器权限不支持 Chromium namespace sandbox，测试实例显式设置了 `ONECLAW_BROWSER_NO_SANDBOX=1`；镜像没有默认关闭 sandbox。
其 DNS 对 example.com 返回 Fake-IP `198.18.x.x`，因此测试实例为 example.com 增加了当时经 DoH 查询得到的真实 IP hosts 映射。
这仅用于验收站点，不代表该环境中所有网站已经可用；通用浏览需要在网络侧为 Runtime 排除 Fake-IP 或提供返回真实地址的 DNS。
不要把 `dangerouslyAllowPrivateNetwork=true` 当作这个问题的通用修复，也不要在生产镜像内硬编码验收站点 IP。

测试实例使用占位模型密钥，验证的是原生浏览器自动化和预览链路，不包含真实 LLM 调用。
登录密码保存在服务器测试目录的 `preview.env`（0600）中，未写入仓库或镜像。

已通过：原生启动/导航/快照/引用点击/脚本执行/聚焦/截图、noVNC 实际画面、独立容器重建后 localStorage 保留、显示服务异常后的自动恢复与手动重连。浏览器默认最大化，保留用户自定义 extraArgs；启动错误以 API 错误返回。启动前只清理旧容器遗留、socket 已失效的托管 profile 单例链接，不删除站点数据；该机制要求一个状态卷只属于一个 Runtime。
