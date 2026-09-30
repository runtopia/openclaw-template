# OneClaw Browser：跨项目梳理与设计建议

日期：2026-09-30，Asia/Shanghai。状态：设计与实施记录；核心跨端链路已实现，本轮按 develop 流程集成并更新模板锁定插件包，尚未部署。第 14 节区分已实现内容与后续工作。

本文最初以审计基线源码、固定 OpenClaw tag 和测试为依据。已有事故文档用于理解演进，不把过去的缺陷、过去的部署记录当作当前实例状态。用户随后将 iOS 和 Android 纳入本轮实现；第 1–13 节保留审计结论和目标设计，第 14 节记录实际改动。

## 1. 结论与产品承诺

建议把 Browser 定义为**任务拥有的工作现场**：每项工作有自己的页面、控制权和可恢复记录；用户随时观看、接手，再让原任务继续。OpenClaw 提供网页执行能力，OneClaw 负责任务归属、人机交接、画面、持久化和资源管理。

当前已经具备任务 ID、任务页面控制、历史截图和输入确认，不需要推倒重做。主要缺口是两套控制入口并存，任务续跑依赖前端，以及高频交互仍通过低频 RPC/截图链路传输。继续往提示词、按钮和全局锁上补条件，很难稳定达到预期。

明确六条产品规则：

1. 打开 A 的画面只是观看，不打断 A，也不切换 B 的页面。
2. 接手 A 后，A 的浏览器写操作停止；B 在自己的页面继续。共享登录账号的业务副作用另行处理。
3. “让助手继续”是服务端持久化的交接与续跑操作。关闭页面、换聊天或换设备不应丢失该意图。
4. 关闭面板、交还控制、停止任务、关闭网页、清除登录资料是五件不同的事。
5. 历史卡片始终打开原任务；网页已经释放就显示历史截图，重新执行必须是明确的新动作。
6. 故障尽量局限于一个任务；只有浏览器进程、共享身份或执行边界确实不可信时才阻断更大范围。

## 2. 审计基线与现有调用链

| 项目 | 本轮基线 | 主要职责 |
| --- | --- | --- |
| openclaw-template | `35522277eb399768784c82f8ea597731022c97cb`，develop | 镜像、桌面、Browser HTTP/WS、CDP 预览/输入、启动与回收 |
| oneclaw-plugins | `7b0623b903d11885d87e30cf1b874bd000c3b34a`，develop | browser-use 的工具钩子、全局/任务控制、页面归属、分享与等待；Channel 的任务/交互协议 |
| oneclaw_api | `1fbbaac21584d0bc17512fd615b74a187c0e74a2`，develop | Workspace 所有权、Runtime 路由、一次性票据、旧 VNC 代理、容器配置 |
| oneclaw_web_v2 | `4c6e09819f5cda197a7eeaff2cb99d1d602e9ea9`，develop | 卡片、任务画面、共享桌面、输入、交还后的聊天续跑 |
| OpenClaw | 本地仓库读取 `v2026.7.1-2` tag | 原生 browser 工具、Playwright/CDP、Profile 和原生标签清理 |

本地 OpenClaw 工作目录自身是其他版本，因此所有宿主能力判断均使用 `git show v2026.7.1-2:...`，没有直接把工作目录或在线最新文档当作部署版本。

另已逐个比对模板当前锁定 Browser Use tgz 中的 8 个 `.mjs` 模块与插件源码，SHA-256 全部一致，确认此处审查的插件逻辑确实进入了当前模板 bundle；这不等于确认线上已部署该 bundle。

### 两条用户路径

| | 任务路径 | 共享桌面路径 |
| --- | --- | --- |
| 入口 | 带 `toolCallId` 的卡片 | 无任务选择器的工具栏、Workspace 分享链接、`panel=browser` |
| Web | `BrowserTaskViewer` | `BrowserUseViewer` / noVNC |
| 画面 | 指定 target 的 JPEG 轮询 | 整个 Xvfb 桌面 |
| 输入 | 任务 token → Wrapper CDP Input | 全局 token → 可写 x11vnc |
| 接管范围 | 任务页面；实际部分检查仍按 Session 扩大 | 整个 Runtime 的受管操作 |
| 资源 | 同一个 Chromium/Profile | 同一个 Chromium/Profile |

任务路径的实际交互：

- AI：原生 browser → 插件 before hook → 全局准入/任务检查 → 必要时 Plugin HTTP 调 Wrapper focus → Wrapper Gateway RPC 校验 → 原生 focus → 原生 browser 执行 → after hook。
- 人工输入：Web Gateway RPC `browseruse.task` → 插件 HTTP 调 Wrapper → Wrapper Gateway RPC `task-authority/input-begin` → 查浏览器状态与 targets → 新建页面 CDP WS → 发输入 → Gateway RPC `input-end`。
- 任务画面：Web Gateway RPC `browseruse.preview` → 插件 HTTP 调 Wrapper → 查状态与 targets → 新建 CDP WS → screenshot → base64 经原链路返回。
- 旧桌面：Web → API 的一次性票据与 WS 转发 → Wrapper → x11vnc。

这解释了为什么目前“操作正确”和“交互顺畅”会分离：大量往返及同步状态落盘处于每次输入的热路径。

## 3. 已有成果与本轮确认的缺口

### 应保留的能力

- 服务端生成 `browserTaskId`，记录 Session/Run/tool call，重启改变 generation，旧页面不冒充活页。
- 任务画面和人工输入按 target 寻址，A 人工控制时 B 的受管网页操作可以继续。
- token 所有权检查、交接排空、未知输入保留、确认补交而不重放输入。
- 历史终态帧、显式 retain/unretain/close、按任务回收。
- API 所有权校验、一次性票据、Runtime 绑定、Origin 与重定向约束。
- 已修复的回收回调死锁、compact target 污染和旧任务响应回写问题。

不能再把 9 月 29 日早期“只有一个最新任务”“所有 Viewer 都是共享桌面”的结论照搬到当前版本。

### 缺口与证据

| 优先级 | 当前事实或风险 | 用户影响 | 源码证据 |
| --- | --- | --- | --- |
| P0 | 两条入口选择两套控制语义；是否有 toolCallId 决定 Viewer | 从卡片打开可以隔离，从其他入口进入却可能接管整个工作区 | Web `BrowserUseWorkspacePanel.tsx:26`、`Workspace.tsx:194`；插件 `share.mjs` |
| P0 | 交还后的续跑依赖内存 waiter 或前端 `onContinue(sessionKey)` | 换聊天/刷新/原 Run 结束后，权限已交还但任务未继续 | Web `BrowserTaskViewer.tsx:237`、`OpenClawThread.tsx:278`、`Workspace.tsx:644`；插件 `share.mjs` |
| P0 | OpenClaw 原生 tabCleanup 默认启用，Wrapper 又有自己的回收 | 人工控制/保留的页可能被另一套清理关闭 | 宿主 `config.ts:253`、`session-tab-registry.ts`；模板 `src/config/browser.js:41` 未协调 |
| P0 | 页面动作清单遗漏 download/waitfordownload | 跨会话下载目标不经过同等归属检查；省略 target 也不补齐 | 插件 `work.mjs:4,117`；宿主 `browser-tool.actions.ts:616` |
| P0 | target/generation 校验存在，但人工输入未携带并验证控制代次、页面文档代次及 frame sequence | 同一 tab 导航、暂停/继续后的迟到输入不能被完整区分 | 插件 `task-control.mjs:194`；Web `BrowserTaskViewer.tsx:73`；模板 `task-broker.js:87` |
| P1 | Viewer 每轮顺序请求状态、控制状态、截图，完成后再等 1 秒；插件截图缓存 900ms | 画面上限约 1fps 且有额外链路延迟；人工输入缺少即时反馈 | Web `BrowserTaskViewer.tsx:107,189`；插件 `preview.mjs:35` |
| P1 | 每个输入重新查状态/list、建 CDP WS、取 layout、确认；队列满 32 直接丢弃 | 拖动、连续滚动/输入容易积压；释放鼠标也可能被丢弃 | 模板 `task-broker.js:161`；Web `BrowserTaskViewer.tsx:270` |
| P1 | 全局不确定操作可暂停 browser/exec/process/gateway/nodes；任务接管也阻止所有 Session 新的共享系统工具 | Browser 小故障影响其它工作；非浏览器工作也可能无法继续 | 插件 `control.mjs:5,120`、`task-control.mjs:75` |
| P1 | 任务接管只排空本 Session/target；其他 Session 已运行的 exec 不参与排空 | 现在的 shell 限制既广泛，又不是可靠的浏览器隔离边界 | 插件 `task-control.mjs:35`、`control.mjs:203` |
| P1 | task 完成主要推断自 agent_end；新 Run 通常建新 task，needsContinuation 又决定复用 | “一条回复结束”与“业务任务完成”容易混淆，续办身份不稳定 | 插件 `work.mjs:164,255` |
| P1 | 卡片由 browser 工具名、action、输出文本提取；并非服务端 BrowserTask 事件 | 新动作/输出变化需要不断修补前端识别 | Web `src/lib/browser-task-preview.ts:25` |
| P1 | task 记录加载上限 128，淘汰记录未同步删除对应 frame 文件；保存截图失败会阻止 close-task | 旧卡片可用性、存储保留期和关闭策略没有完整契约 | 插件 `work.mjs:56,120,373`、`index.mjs:219` |
| P1 | 人工弹窗采用输入结束后的 targets 查询及 openerId 认领，没有持久的 target 生命周期订阅 | 异步延迟弹窗、自动关闭/导航等状态可能滞后或缺失，需要对账 | 模板 `task-broker.js:319`；插件 `work.mjs:398` |
| P2 | 任务 Viewer 只显示网页像素；键盘/文件选择/浏览器原生弹框能力有限 | 不能直接承诺完整远程 Chrome 体验 | 模板 `task-broker.js:4`；Web `BrowserTaskViewer.tsx:608` |

“下载归属”和“输入版本”是插件/协议层复现，不等同于已经在真实网站重现跨账号数据访问或误点击。原生清理冲突是默认配置与源码路径确认，未检查当前线上实例是否另有显式覆盖。

### 原生标签清理：必须先统一所有权

固定宿主默认 idle=120 分钟、每 Session 最多 8 个 tab、每 5 分钟 sweep。原生 registry 的 lastUsedAt 来自原生工具调用；Wrapper 的 CDP 人工输入、观看和 OneClaw retained 不会同步到它。清理直接调用 browserCloseTab，不经过 OneClaw before_tool_call。

建议受管 Browser 启用时由 OneClaw 接管空闲回收，显式关闭原生周期 tabCleanup，并记录迁移行为；不要只把原生阈值调大。另须单独核对 Session reset/delete 的生命周期清理入口——关闭周期配置不代表这些入口也被关闭。用户删除聊天如何处理保留页，应走一致的关闭/归档事件。

### 原生目标解析：还有一项需要真实回归验证

固定宿主 `pw-session.ts:getPageForTargetIdOnce` 在指定 target 未找到、Playwright 仅暴露一个 page 时会回退到该 page。OneClaw 的归属检查要求精确 target，这个宿主回退与目标契约不一致。已有 focus 预检可减少窗口，但无法作为所有动作和关闭竞态的最终保证。受管模式需要 strict-target adapter；找不到页就返回 PAGE_GONE。是否在特定动作路径实际触发，列入 pinned-host 集成测试，不把源码分支等同于本轮实测事故。

## 4. 资源模型：任务、登录身份、浏览器进程分开

建议采用下列实体，禁止互相替代：

| 实体 | 寿命与职责 |
| --- | --- |
| ChatSession | 用户聊天上下文，可包含多项工作 |
| BrowserTask | 业务工作的浏览器部分；跨 Run、跨前端重连稳定；绑定所属 Session/任务 |
| Run | 某一次 Agent 执行；可等待、结束、被新的 continuation Run 接续 |
| BrowserIdentity | 登录资料及共享规则，默认 Workspace 的受管身份；以后支持指定账号身份 |
| BrowserResource | Profile/Context/进程的实际资源，含运行代次和容量 |
| Page | task-owned 页；稳定内部 pageId 映射当前 CDP target；弹窗继承来源归属 |
| ControlLease | 某设备控制某任务的一次排他授权，带单调 epoch |
| Operation | 一次已准入的自动化或人工动作，明确完成/失败/未知 |
| Handoff | 交接意图与续跑状态，持久保存，不能只存在 waiter/React ref 中 |

BrowserTask 在第一次准备执行网页工作时建立，服务端将 ID 写入可信 Run 上下文；工具调用返回后再认领页面。开始、失败和排队都能立即展示卡片。Model 不负责猜 ID，也不靠“请继续”文本选择原任务。

同聊天的新话题创建新 task；明确续办绑定原 task。旧页面若要转给新 task，必须完成显式资源转移、终态帧保存与版本更新，不能仅凭后续工具返回自动改变归属。

### 隔离方案的取舍

| 方案 | 任务画面/输入隔离 | 登录态 | 成本与限制 | 建议 |
| --- | --- | --- | --- | --- |
| 当前共享桌面/VNC | 只能全局接管 | 全部共享 | 无法提供 A 接手、B 稳定操作的常规产品语义 | 保留管理员诊断用途，退出普通任务入口 |
| 一个 Chromium/Profile，task-owned pages + broker | 可按页面隔离 | 同身份共享 cookies/storage | 成本低；账号切换、购物车等站点状态会互相影响 | 第一阶段主路线 |
| 同进程独立 BrowserContext | 可按任务/身份隔离 | Context 隔离 | 登录复用和持久化需单独设计，仍共享进程故障域 | 公共任务或独立身份按需启用 |
| 独立进程/Profile/容器资源池 | 最强的进程故障与环境隔离 | 每身份/任务独立 | RAM、冷启动、配额、登录迁移成本增加 | 后续按业务与测量结果扩展 |

不建议立即“每个聊天启动一个独立容器”，也不建议把“不同 tab”宣传为账号隔离。同身份 A 退出登录、切换租户、修改共享业务对象，会影响 B，不能用浏览器锁掩盖。

需要严格账号隔离时分配不同 BrowserIdentity/Context；需要同账号并发时声明共享语义，并对已识别的账号切换等动作做身份级协调。任意网站的业务副作用无法靠通用域名锁可靠识别，无法判定时应让相关工作串行或显式选择独立身份。

Playwright 的 Context 提供 cookies/storage 隔离，但普通 newContext 不持久写盘；persistent context/Profile 不能让多个浏览器进程同时写同一 userDataDir。不能靠复制正在使用的 Profile 来解决并发登录问题。[Context 隔离](https://playwright.dev/docs/browser-contexts)、[BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、[持久 Context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。

## 5. 收敛成一个 Browser Authority

目标是在 Runtime 内形成一个逻辑上的 Browser Service，统一任务、页面、控制、操作记录和回收。先作为 Wrapper 中清晰划分的模块运行，达到稳定后才决定是否独立进程；不引入远端微服务作为每次点击的依赖。

| 层 | 目标职责 |
| --- | --- |
| Browser Use 插件 | 原生工具适配、从可信上下文取得 task 身份、准入/完成通知、给模型的精简指南 |
| Runtime Browser Service | 唯一控制权与页面资源 authority、执行队列、输入/媒体会话、操作账本、资源协调 |
| OpenClaw adapter | 复用原生 snapshot/act/导航/文件能力；精确 target、取消/完成契约与版本检查 |
| OneClaw Channel | BrowserTask/Attention/Artifact 对外事件，人工需求、交还意图和任务续跑；沿用 v2 transport |
| Go API | 用户/Workspace/Session 权限、Runtime 定位、连接票据、事件投影与历史查询 |
| Web | 订阅权威状态、显示卡片/画面、表达用户意图；不自行判定是否完成交权或补发业务续跑 |

不要让 API Redis、Gateway 插件和 Wrapper 各保存一份可独立授予控制的真值。API 可以保存投影与命令队列，但不能自行解除 Runtime 的输入锁。

迁移时先在现有插件内统一 control/task-control 的状态定义及 contract，再把 authority 整体切换到 Runtime 服务。**同一个 BrowserTask 全程只有一个 authority owner/version**。v1 继续由旧 authority 管，v2 新任务由新服务管；用 feature flag/version 路由，不双写、不对同一动作执行影子调用。

### 原生 browser 如何保留

保留原生浏览器的 DOM/ARIA snapshot、ref 操作、导航、上传下载等成熟能力。OneClaw 不另造一套点击算法。对外给模型保留一致工具语义，但所有页面动作必须执行统一的动作分类、task/page 检查和准入。

近期 before/after hook 可以继续作为合作式准入方案；中期适配器需要让执行、取消与完成结果进入同一个 broker 契约。不得把“拿到了一个 hook lease”宣传为底层 CDP 已被强隔离。升级 OpenClaw 必须跑动作覆盖与目标解析契约；宿主私有接口适配必须集中、固定版本校验，无法验证时明确停用该能力。

原生工具能用 target 精确操作时去掉常规动作前额外 focus，减少全局前台状态及回调依赖。但应先验证固定宿主的全部动作，不可在验证前直接去掉全局 browser 串行锁。初期可以保留 adapter 内的短串行调度，同时允许 A 人工页与 B 原生页并行；逐步放开无共享状态的操作。

通用 exec 能访问同容器 CDP，意味着任何插件规则都不是任意代码执行的隔离。短期明确限制无法归属的浏览器脚本并处理已运行脚本的交接排空；要长期让任意 exec 与人工控制安全并行，必须把 Browser/CDP 放到通用执行环境无法直连的进程/网络权限边界后，令其只能经 broker 获取受限能力。完成此边界后，才移除目前广泛拦截普通 exec 的兼容策略。

## 6. 状态模型与人机交接

不要再用一个 paused 表达四类事实：

| 维度 | 建议状态 |
| --- | --- |
| Task | queued、running、waiting_user、completed、failed、cancelled |
| Resource | provisioning、live、reclaiming、archived、lost |
| Control | agent、draining、human、paused、returning |
| Health | ready、degraded、recovering、unavailable |

每次返回附带 reasonCode、可执行 actions 和 retryability，由客户端展示通俗文案。所有动作以 capability 判断，不靠客户端从 mode 拼条件。

### 接手

1. 用户点击“我来操作”，提交 commandId/idempotencyKey、browserTaskId、expectedRevision。
2. authority 将该 task 原子改为 draining，关闭该 task 新写操作准入。
3. 等当前动作结束。不能以 RPC 超时充当动作完成；允许取消的动作发取消并等执行器确认。
4. 签发新 controlEpoch、controllerSession、短期输入能力；给客户端当前页面与首帧。
5. 客户端收到授予确认且首帧匹配后才允许输入。B 在独立页面继续工作。

接手请求必须能在当前步骤执行中被提交并排队，不能让按钮一直因为 inFlight 禁用而无从表达意图。Web 当前有此限制，服务端已有 draining 基础可以复用。

### 交还并继续

1. 点击“让助手继续”，客户端立刻停止采集新的输入。
2. authority 进入 returning，撤销当前输入代次，排空已接受输入；未知输入进入任务恢复状态。
3. 写入交还完成和 continuation intent，更新控制代次；fresh snapshot 对该 task/page 生效，不使 B 已有观察凭据全局失效。
4. 若原 Run 正在等待，唤醒它；若原 Run 已结束，由 Channel 调度带 browserTaskId/handoffId 的 continuation Run。
5. 两条续跑路径通过同一个持久化消费记录互斥，前端重试不重复执行。前端显示“正在继续”直至服务端返回 runStarted/waiting/failed。

这里要求的是幂等接受与单次续跑调度，不承诺网络环境下所有外部网页副作用 exactly-once。点击/提交结果未知时核查结果，不能重放原提交。

任务已经完成、用户只是查看并手工操作：交还只变更控制，不再次执行已完成任务。用户取消原任务：迟到的交还不得复活它。等待审批：交还不能绕过审批。Agent 可以继续独立的非浏览器工作，但不能在同一浏览器任务等待人工时把业务状态报告为完成。

### 离开、断线、多设备

- 普通观看关闭：取消媒体订阅，AI 继续。
- 人工操作关闭：默认保留暂停，可显式选“让助手继续并关闭”。
- 隐藏/断线：立即失效输入能力，保留任务；重连恢复观看，人工写权限需要显式恢复。
- 心跳过期只撤销输入资格，不把未知操作按时间判成已完成，也不自动交还 AI。
- 第二设备可观看；申请转移控制需要对旧设备撤权、排空和生成新 epoch。
- 旧设备的迟到 command/ack/frame，按 Runtime generation、controlEpoch、operationId、inputSeq 验证。

## 7. 画面和输入：从轮询改为任务媒体会话

低频状态/Attention/Artifact 继续走 OneClaw Channel；视频或图像帧走独立 WS，避免 base64 大帧与聊天工具事件共用同一 Gateway JSON 链路。该媒体端点只传授权画面/输入，不成为新的私有 Task 或 Interaction Broker。

先实现持久 CDP session + 独立 WS 二进制图像流。可以原型验证 CDP `Page.startScreencast`；它是实验接口，需要测试实际镜像 Chromium、后台 tab、导航、弹窗和帧 ACK。若后台 task screencast 不稳定，则同一个持久 CDP 上自适应 screenshot，或分配独立资源；不能靠反复 bringToFront 抢其它任务画面。WebRTC 作为确有带宽/延迟收益后再引入的传输升级，先不增加其部署复杂度。[CDP Page 接口](https://chromedevtools.github.io/devtools-protocol/tot/Page/)。

建议起始策略：AI 观看 2–5fps，人工操作目标 10–15fps；静态页降频，无订阅停采样，后台卡片只更新缩略图。它们是原型目标，不是当前已达到的性能。

每个 task/page 只采集一份流，多 viewer 扇出；队列只留最新帧，过期帧丢弃。高分辨率面板与卡片共用采集来源，按需缩放，不各开一套 capture。

帧元数据建议包含：

```ts
type BrowserFrameIdentity = {
  browserTaskId: string;
  runtimeGeneration: string;
  resourceGeneration: string;
  pageId: string;
  documentEpoch: number;
  viewportVersion: number;
  frameSeq: number;
  capturedAt: number;
};
```

人工输入附带 controllerSession、controlEpoch、inputSeq 和上述关键 frame 身份。broker 校验任务/页/文档/视口仍匹配，再执行坐标输入。文档导航或视口变化后拒绝旧输入并要求新帧；不要求每次有无关动画的新帧都使鼠标动作失效。

输入队列分别处理：move 可覆盖合并，scroll 可有界累积；down/up、文本提交与关键按键不能静默丢弃。队列满时明确背压并停止新增手势。一个鼠标手势的按下/移动/释放与控制 epoch 关联，退出/断线时处理已按下状态。

broker 持续订阅 targetCreated/targetDestroyed、页面导航与 dialog/download 事件；弹窗通过 opener 关系继承归属，无法确定来源的页保持 unclaimed，不能靠 URL 相似猜测归属。定期对账修正漏事件，未知页不静默关闭。

IME 发送已提交字符串，保留中文/emoji；补齐常用修饰键、全选、复制粘贴、双击/右键的产品决策。剪贴板须是明确授权动作，不能默认镜像用户系统剪贴板。文件上传通过 OneClaw 文件资源选择并传给原生 browser upload；下载成为 Artifact，不能把整个容器目录暴露给用户。

JS dialog 用页面事件渲染对应操作；OS 文件选择器、Chrome 权限弹框、WebAuthn 等不属于普通网页像素输入，应有明确支持矩阵与独立流程。遇到不支持的系统 UI，不能偷偷降级到共享桌面接管。

## 8. 协议与持久化

以下是待实现的逻辑接口，不是宣称目前 OpenClaw/Channel 已有这些方法：

| 操作 | 契约 |
| --- | --- |
| get/list/subscribe task | 精确 task 身份、revision、capabilities；支持事件游标重连与 snapshot 兜底 |
| requestControl | commandId、expectedRevision；返回 draining/granted 与控制代次 |
| returnControl | commandId、handoffId；返回 release 与 continuation 分开的进度 |
| pause/resumeControl | controllerSession 与 expectedControlEpoch；仅切换人工输入资格 |
| close/retain/reopen | 明确资源动作；reopen 建新资源 generation，旧截图保持历史身份 |
| createViewerSession | API 校验权限，签发只读/控制能力；绑定 Runtime、task、generation、Origin 与过期时间 |
| input/ack | 有序 inputSeq；确认接受/执行状态，重试只查结果而不盲目重放 |

BrowserTask 状态与人工需求通过 Channel 的版本化事件/Attention 表达，新增字段/命令要同步 contracts 的 schema、fixtures、validation、Go 投影与 Web reducer。不直接给现有 v2 transport 塞未经定义的浏览器事件；不新增 `/repair/interactions/*`。

控制状态要有单调 task revision；控制 epoch 独立于 resource generation。运行时重启不等于任务消失，但旧 target/input capability 必须失效。页面身份和终态截图可保留；恢复页面应明确展示“重新打开”，不冒充仍停在原编辑现场。

本地采用事务化状态/操作日志（例如独立 SQLite WAL），将 lease、operation 和 handoff outbox 放在可一致提交的边界。不要让三份 JSON 的独立原子 rename 承担跨实体事务，也不应为每个 mousemove 同步重写完整 task 集合。输入批次与 crash 恢复须保守定义，日志并不自动证明网页副作用完成。

API 保存 BrowserTask 的可查询投影和截图 Artifact 引用，使 Runtime 暂停时历史仍可读。读投影带 lastSyncedAt，不用于授予写权限。媒体票据延续现有一次性、短期、Runtime/Origin 绑定；新增 task/role 绑定，不能仅凭 taskId 获取画面。

错误用稳定码，如 TASK_GONE、STALE_CONTROL、STALE_DOCUMENT、CONTROL_OWNED、OPERATION_UNCERTAIN、RESOURCE_UNAVAILABLE；客户端展示原因对应动作。现在层层转成 UNAVAILABLE/409 的做法会把登录失败、页面已关闭和操作未知混在一起。

## 9. 回收、恢复和部署

一个 lifecycle coordinator 管理页面关闭与进程停机。回收流程先在短事务中标记 reclaiming/锁定 revision，再在锁外采集终态帧和关闭，最后提交结果。外部 RPC/callback 不得持有会被回调再次申请的队列；历史死锁应成为架构约束而不只是一个局部测试。

建议保留现有 30 分钟作为初始无人使用页面回收策略，先统计资源而非凭感觉调短。区分：

- 业务完成时间；
- 该 task 的观看/人工活动时间；
- 该 BrowserResource 的最后使用时间；
- 人工保留原因及保留期限。

retain 是用户明确的资源选择；人工编辑过的页面默认保护，但交还后可提醒保留策略，避免所有接手过的页永久占用。资源限额到达时排队并展示原因，不杀掉仍有人编辑的页面。

正常关闭先保存终态帧；若采集失败且有可信旧帧，标记其时间与 stale 状态；没有可用截图则显示“无最终截图”。是否继续关闭取决于用户明确关闭还是自动回收，不能为了截图无休止泄漏进程，也不能无声丢掉用户编辑。截图/元数据保留期独立于活页 TTL，统一清理失去索引的 frame 文件。

故障按范围处理：媒体断线只重建观看链路；单页丢失使该页失效；某 task 输入未知暂停该 task；Chromium 崩溃影响其承载的全部 task；authority/持久状态损坏影响该 authority 管理范围。不能简单地把所有不确定执行局部化，特别是共享 Profile 或任意 exec 仍可影响整个进程时。

对能证明的状态做定向恢复：确认 operation 未 dispatch，可安全结算为未执行；target 已关闭可确认关闭后置条件；执行 worker/旧浏览器进程已停止，可撤销其能力并把任务标为需重观察。无法证明的提交结果保持 unknown，让用户核查，不靠租约到期自动成功。

还需针对原生 navigate/act 的超时做执行器级故障注入：当前 `control.end()` 对普通完成钩子移除记录，只对已标 uncertain 的记录保留；不能仅靠 before/after hook 的返回推断底层动作一定停止。固定宿主若已提供可靠取消确认就复用；否则应在 adapter 中把“收到工具错误”和“执行已终止”分开。此项是待验证边界，不宣称本轮已复现超时后的迟到点击。

部署模板增加 Browser readiness contract：display、Chromium/CDP、sandbox、持久 Profile、broker、宿主 adapter 版本分别报告。Gateway ready 不能代表 Browser ready。API 当前 Docker seccomp 默认继承问题已修复，下一步应把浏览器启动探针纳入新实例验收，Railway 与 Docker 分别验证。失败通过 Channel 产生可解释的服务状态，不能让模型杀共享 Gateway 或改成 headless 自救。

保留按需启动 Chromium；后续验证可以按需启动显示/VNC 服务。登录资料留在 Volume；不在启动时复制大 Profile，不为普通配置更新重启 Gateway。采样和事件日志只记录 ID、状态、延迟、错误码，避免保存密码、输入正文、完整敏感 URL 和页面像素到通用遥测。

## 10. Web 应呈现的体验

卡片绑定 browserTaskId，标题是具体工作，附站点、进展与最后画面。点击进入同一任务，URL/恢复状态带 taskId；普通工具栏先展示本聊天任务选择，不能在缺少 toolCallId 时自动落到全局 VNC。

| 情境 | 用户看到 | 可执行动作 |
| --- | --- | --- |
| AI 工作 | 助手正在查看网页 | 我来操作、收起画面 |
| 排空 | 正在等当前步骤结束 | 取消接手 |
| 人工控制 | 现在由你操作 | 让助手继续、暂时离开 |
| 人工登录 | 请在这个网页完成登录 | 登录好了，让助手继续 |
| 续跑已接受 | 正在继续原任务 | 看进展；必要时取消任务 |
| 连接恢复 | 正在重新连接画面 | 显示最后帧时间，禁止旧画面输入 |
| 结果未知 | 此次操作需要核查 | 看实际页面/结果、请求恢复 |
| 已完成/释放 | 结果与最后截图 | 查看截图、明确重新打开 |

用户切换左侧聊天时，可以保留固定的 A 画面，也可以跟随新聊天，但必须显示画面所属任务。不能在视觉上保留 A、底层 input identity 却跟随 B。等待登录/验证码等人工需求发布结构化 Attention，并能从任务列表返回；不只靠模型说一句“请接管”。

付款、发送、授权等审批沿用既有独立 Attention/Approval 规则。接手/交还只管理控制权，不代表批准 AI 后续任意操作。

## 11. 按依赖顺序落地

| 阶段 | 插件与模板 | API/Channel/Web | 退出条件 |
| --- | --- | --- | --- |
| A：补齐当前边界 | 动作分类覆盖 download/waitfordownload；验证 strict target；统一原生/自有清理；补录操作/控制代次；建立能力版本 | 入口明确 task/global，错误码与任务选择；补 Browser probe | 不串页、不误关人工页，所有受管动作均有归属与失败契约 |
| B：打通交接与续跑 | 统一任务/控制状态，持久 handoff 与幂等 completion；限制故障范围 | Channel BrowserTask/Attention 契约与续跑消费；删除前端补发“继续”的主路径 | A 接手、B 继续；换聊天/刷新/关闭 Web 后交还只续跑原任务一次 |
| C：提升交互 | 常驻 CDP、独立媒体/输入流、背压/帧身份、弹窗及上传下载 | API task-scoped 票据；Web 统一 Viewer/输入模块 | 达到实测首帧、输入反馈指标；连续输入无静默丢失 |
| D：资源与扩展 | 单一 lifecycle、容量与恢复、可选 Context/资源池；必要时迁移 authority/隔离 Browser 服务 | 历史投影与 Artifact 保留、资源状态展示 | 长时运行、故障注入、负载和账号共享场景验收 |

迁移 authority 可结合 B/D 的实际复杂度实施，先实现逻辑单一权威再调整进程位置；不要为了“拆服务”拖延可直接修正的 P0。每个阶段都要交付完整可用路径。

开发沿用现有 develop → 101 验收 → main 的流程。插件源只改 oneclaw-plugins，模板更新内容寻址 tgz；生产版本使用既有发布协调流程。新 task 使用 protocolVersion/capabilities；旧历史仍能只读查看。回滚不得把 v2 task 带着活跃控制者移交旧 v1 authority。

## 12. 验收必须围绕用户任务

先测以下场景，每个场景记录 task/page/epoch/operationId/Run 证据，不记录账号敏感内容：

1. A 搜索、B 查另一个网站，打开各自卡片不抢页面。
2. A 人工登录，B 继续导航和生成结果；A 交还后自动重新 snapshot 并继续。
3. A 有两个页、B 有弹窗；新页/下载/对话框归属正确，禁止另一 task 认领。
4. 接手发生在长导航或点击在途，等待/取消接手都不重复执行动作。
5. 接手后切换聊天、刷新、打开第二个 Web 标签；输入和续跑不转移到错误任务。
6. 人工连续输入中文、英文、emoji，拖动及快速滚动；队列满不丢 mouse-up。
7. 同一 tab 导航后旧帧点击、暂停后迟到请求、旧 epoch ack 全部被拒绝。
8. 注入 input-end 确认丢失，只补确认，不重放点击/文本。
9. 关闭 Web 后完成交还命令，后台仍能消费续跑；取消任务后迟到交还不复活任务。
10. 原生 tabCleanup 阈值及 >8 tab 条件不会绕过人工控制/retain；Session reset/delete 行为符合约定。
11. Completed/failed/cancelled/retained/unknown page 多种组合，只回收允许的页；最终帧和 Profile 保留。
12. Gateway/Wrapper/Chromium 分别重启，旧能力失效，已完成历史可读；只有正确范围进入恢复。
13. `download`、`waitfordownload`、upload/dialog/pdf/console/act 的所有子动作覆盖精确归属；单剩一页时不触发错误 fallback。
14. 同账号退出/切换账号影响得到解释；独立身份模式下 cookies/storage 不混用。
15. 2/5/10 个任务、1/3 个 viewer 做容量测试，采样 RAM/CPU、首帧、输入反馈、队列与聊天延迟；据结果设置配额。

建议目标（不是本轮测量值）：同区域热首帧 P95 <1.5s；人工输入到可见反馈 P95 <250–400ms；无在途动作接手确认 P95 <1s；交还后的续跑接受 P95 <1s，Agent 真正开始时间另测。跨区域单列 RTT；不能通过丢输入或提前宣告交权“优化”指标。

## 13. 本轮验证与证据边界

已执行：

- Plugins：`node --test plugins/oneclaw-browser-use/test/*.test.mjs`，62/62 通过。
- Template：`node --test test/browser-*.test.js`，54/54 通过。
- Web：`node --import tsx --test src/lib/browser-*.test.ts`，29/29 通过。
- API：`go test ./internal/workspace ./internal/runtime -run 'Browser|RuntimeAppOrigin' -count=1`，两个 package 通过；这是定向测试，未声称全量质量门通过。
- 独立临时内存状态复现：A 对 B 的 navigate 被拒绝，download/waitfordownload 的 prepare 接受；B exec 已在途时 A task request 得到 human/inFlight=0；input-begin 不验证额外提交的 epoch/frameSeq；模板默认配置未设置 tabCleanup。临时状态已清理。
- 读取固定宿主源码确认原生清理默认/调用路径、下载动作和单页 target fallback。

本轮没有运行真实 Chromium/UI 网络任务，没有复测 Muse，没有操作线上/101 实例，没有读取用户网页登录内容。前述体验与故障链路结论区分源码事实、最小复现及待实测风险；当前测试通过不等于长时任务、媒体性能与所有交接场景已验收。

Muse 的公开说明强调后台工作、浏览器执行和确定性的人工交互；仓库已有 9 月 29 日的 Muse UI 观察，记录了 A 人工控制时 B 完成导航。这些可以作为产品验收参照，但不能据此判断 Muse 内部采用 Context、容器或 VM。Grok bot/dot 本轮未做具体产品版本验证，不对其内部实现下结论。[Muse 产品设计说明](https://introducing.muse.ai/)。

在线 OpenClaw 文档只用于理解通用能力，不替代固定 tag。[Browser control API](https://docs.openclaw.ai/tools/browser-control)、[Browser configuration](https://docs.openclaw.ai/tools/browser/configuration)。

## 14. 跨端核心实现进展

六个仓库的实现分支为 `codex/browser-task-runtime`，本轮按用户要求合入并推送 develop。先同步插件 develop，再运行 `npm run update:local-browser-use` 更新模板锁定包，最后合入模板 develop；没有部署到 101 或生产。iOS 原有未跟踪文档、Android 原有 AGENTS/.agents 等文件保持原样且未纳入提交。移动端采用现有 WKWebView / React Native WebView，共享 Runtime Viewer 的媒体与输入实现，不另建原生浏览器控制引擎。

| 层 | 已实现 |
| --- | --- |
| Browser 插件 | 补齐 download/waitfordownload 归属；持久化控制 epoch，pause/resume 隔断迟到输入；交还只使本 Session 的观察失效；交还与续跑意图同文件原子保存，重试同一 handoffId；已验证 strict-target 的镜像省去常规页面动作前额外 focus |
| Template | 托管模式关闭原生周期 tabCleanup；固定版本 strict-target 补丁避免单页回退；页面 CDP 连接池，截图/输入共用连接；输入校验截图凭据、导航文档/视口与接管后的新帧；已确认输入只补 ack，未知输入不重放 |
| 媒体 | 新增只读 `/browser/task-stream` 二进制 WS，元数据与 JPEG 分开编码；共享采样缓存、限流、慢连接丢帧；Web 和公共 Viewer 接入，暂时不可用时保留鉴权截图回退。当前采样间隔 200ms，不能宣称已达到 10–15fps |
| API | task 模式一次性媒体票据绑定 Workspace/Runtime/Session/task；新增 Runtime handback 入口，经现有 Channel message lane 持久提交，复用鉴权/额度/唤醒；校验原 Run、取消/替换状态，事务内再次核对；同步 OpenAPI |
| Web | 工作台入口统一任务 Viewer，首次解析后固定 task；不再依据缺少 toolCallId 转到全局桌面；版本化控制与截图凭据；交还等待已接受输入完成；服务端有 continuation 回执时不补发聊天消息 |
| iOS | 每次打开生成 viewerId；校验 Session/tool call/task/generation，拒绝旧回调；前后台显式暂停/恢复观看，写权限不自动恢复；服务端续跑回执阻止重复提交 |
| Android | 相同 Viewer 身份/续跑规则；WebView 按票据重新挂载，关闭时只通知原票据的 View，避免暂停新任务；前后台通知共享 Viewer |

兼容边界：新版客户端仍能读取旧 Runtime 事件；新版 task 控制以 `controlProtocolVersion=2` 协商。旧 Workspace 分享链接和直接 `/browser/` 的管理员桌面仍保留；常规会话入口已走 task Viewer。没有静默更换 Cookie/Profile 的隔离语义。

### 实施验证

- Template 全量 315 项测试通过；新增媒体授权/只读二进制传输、CDP 重用、导航/滚动后拒绝旧帧、严格 target 与清理配置测试。
- 使用 `BROWSER_USE_SOURCE_DIR` 直接加载当前插件源进行 Wrapper 生命周期回调集成测试，5 项通过；正式锁定 tgz 的默认测试路径也保留。
- Plugin 67 项测试通过，覆盖交还落盘/重试同一 Channel ID、旧 epoch 拒绝、局部快照失效及无 focus 准入。
- Web 30 项 Browser 测试、TypeScript、定向 ESLint 通过；Android 21 项 Browser 测试、TypeScript、定向 ESLint 通过。
- API `scripts/check-go-quality.sh` 全通过：格式、600 行限制、依赖、OpenAPI 契约、全量 test/vet/build。
- iOS Debug 编译和静态检查通过；已连接 iPhone17-Ropon 上 11 项 Browser XCTest 通过。测试命令使用现有开发证书团队覆盖旧测试 target 团队，未更改项目签名设置。遵守本轮授权，没有启动模拟器，没有执行 E2E。

### develop 集成与模板锁定包

插件源提交 `d17aac6` 已合入插件 develop `062c356` 并推送，随后更新脚本从干净且与远端同步的 develop 打包。新归档为 `oneclaw-plugins-browser-use-0.1.0-d904e3806230445feb9d1c03fec853edccfaf435a8b731985773552cd3a3acf2.tgz`，完整 SHA-256 与文件名一致；package.json 和 lockfile 由脚本同步生成，旧归档移除，没有覆盖旧文件名的内容。更新脚本再次执行插件 67 项测试、语法检查和模板 5 项锁定包校验，均通过；模板随后使用新锁定包执行全量 315 项测试和 lint，均通过。

其余已推送的 develop 集成提交：API `c94f1d9`、Web `bf353d9`、iOS `b3bc79e`、Android `fa96193`。本记录与模板运行时及锁定包一并合入模板 develop。

### 尚未完成的集成与更大范围设计

1. **未做 101/Railway 部署或真实网站 E2E**：Docker 中固定 `2026.7.1-2` 完整 bundle 补丁验收、媒体实际帧率/输入 P95、长期回收、三端真实接管/后台场景，仍需在集成候选上验证。单元测试不替代这些证据。
2. **目标架构的后续部分**：BrowserTask 的独立 Channel 资源事件/历史投影、authority 整体迁移/SQLite 事务、多账号 Context/进程池、任意 exec 的进程/网络隔离、完整上传/系统弹框交互和原生 Session reset/delete 统一资源策略，本轮没有实现。现有全局共享桌面与共享系统工具保护仍保留，不应宣称实现了全浏览器强隔离。

部署顺序应先 API，再同步的新插件与 Template，最后三端客户端。打包后先做 A 人工控制 / B 导航、交还断线重试、取消后不复活、旧帧/旧代次拒绝和前后台恢复的联合验收，再决定是否扩大灰度。

## 15. 用户部署后 Chrome 实际验收（2026-09-30）

用户告知镜像已更新并部署测试环境后，通过用户 Chrome 的现有登录态实际操作网页。应用为 `http://192.168.1.185:3007`，工作画面入口实际跳转到测试 Runtime `http://192.168.1.101:18082/browser/`。本轮没有登录第三方账号、提交订单、上传个人文件、修改 Runtime 配置或重启服务。验收文档和保存截图不包含登录凭据或媒体访问票据；截图文件只记录本轮验收画面。

测试会话：

- A：`agent:main:dashboard:5cd125df-1370-4368-b557-38e3fbc69741`。
- B：`agent:main:dashboard:9a1fc9e6-fe0a-46e0-9cae-d51002689cba`。
- 页面为百度、example.com 和 12306；所有输入使用本轮验收标记。

结论：**任务 Viewer 主流程通过多项实际操作，但整体验收不通过**。分享入口仍进入全局桌面；无存活等待器场景没有自动续跑；历史卡片元数据和截图呈现仍有问题。

### 实际操作结果

| 场景 | 结果与证据 |
| --- | --- |
| A 新页打开、任务结束后查看 | 百度页面打开；已结束卡片仍可打开实时任务 Viewer |
| 人工接管与鼠标输入 | 接管成功，点击远端搜索框生效 |
| 中文、英文、数字、emoji | `Browser隔离验收A 中文 English 123 😀` 完整显示于远端页面 |
| A 人工控制期间 B 导航 | B 在自己的同一标签页完成 example.com → 12306，A 搜索框标记未改变；12306 导航有一次响应超时，页面实际完成导航 |
| 两任务独立接管 | B 在 A 持有人工控制时也能接管自己的 12306 页面 |
| B 输入与滚动 | `Browser-B-0930` 写入 B 的 12306 搜索框，远端滚动到页尾并返回 |
| A 刷新恢复 | 画面与任务恢复，显示“你已暂停操作”，未静默恢复写权限 |
| 活跃 wait 的交还 | A 正在等交还时刷新并点击交还；原任务继续读取原搜索框，输出一次 `HANDOFF-A-0930`；没有另发“继续”消息 |
| 同任务第二个 Viewer | 显示“此任务由另一连接控制”，没有接管按钮；向其隐藏键盘输入 `MUST-NOT-WRITE-0930`，远端 B 搜索框仍为 `Browser-B-0930` |
| 返回聊天保持暂停 | 弹出“交还并返回 / 保持暂停并返回 / 取消”；选择暂停后，另一 Viewer 状态收敛为暂停；重开原 Viewer 仍需显式继续 |
| 取消后交还 | A 等待时点击“停止生成”，再交还；任务维持已停止，没有复活（后续多项测试期间持续检查） |
| 媒体连接 | Chrome Network 可见独立 browser-use 媒体 WS 返回 101，票据请求返回 201；尚未采集消息帧率、延迟分布或丢帧率，不能据此声称性能目标达标 |
| 页面显式关闭 | B 的 12306 测试页关闭后显示“网页已释放 · 保留最后截图”；刷新仍可查看归档画面，无人工控制按钮 |
| 归档后新任务 | B 创建新任务并打开 example.com、百度两张新页，未复用已归档页 |
| 同任务两页切换 | 接管后切换两张页，按钮选中态、URL 和实际画面一致 |
| 输入后立即交还 | B 新百度页输入 `B-MULTI-交还前输入-0930` 后立即交还，文本完整落在 B，A 原标记保持不变 |
| 重开旧卡片 | B 已创建新双页任务后，再打开旧卡片仍是归档 12306，不会自动跟随新百度任务；但卡片文字错误地显示 example.com |
| 无存活等待器自动续跑 | **失败**：A 接管后，让 Agent 只尝试一次原生 snapshot，受阻后结束本轮。点击交还仅恢复 AI 控制，未自动继续未完成的读取任务。此会话是 dashboard owner Session，不能将此结果等同于 OneClaw Channel 的服务端 handback 入口已验证 |

### 待修复问题

1. **P1：会话生成的工作画面链接没有任务身份。** B 明确要求生成其 12306 任务入口，`browser_use share` 返回 workspace 级 `/browser-use/<workspace>`，应用仍跳转到 Runtime `/browser/` 全局桌面。首次标题显示 A 的百度；随后标题仍显示百度，桌面前台已是 12306，证实它跟随全局前台，不能承担会话任务 Viewer 的承诺。源码链路为插件 `share.mjs`、Web `BrowserUseEntry.tsx` 和 `resolveBrowserUseEntry()`；修复需将可信 Session/task 身份贯穿链接、鉴权和 Runtime task Viewer，缺少身份时明确选择任务，不能默认选任意全局页面。

2. **P1：没有存活等待器时，当前 Web 会话交还不自动续跑。** 人工阻止读取后，Agent 按验收条件结束本轮；点击交还后仍无新读取结果。活跃 `browser_use wait` 场景确实成功，两者必须分别验收。源码显示 durable handback 只对 `:oneclaw:direct:session_…` 创建，而本轮应用创建的是 `:dashboard:…` Session；另外任务级控制阻止原生调用时，`work.waiting()` 的判定仍依赖全局 control.mode。需要核对任务等待状态、当前 Web Session 与 Channel Session/Run 的映射，以及 `continuation=not_needed` 的返回条件；不能用“已有 continuation 字段”取代实际接受续跑的回执。

3. **P2：刷新/历史重建后，卡片 URL 与实际任务 URL 不一致。** B 首轮实时卡片显示 12306；第二 Viewer 与页面刷新后，历史卡片文字回到最初 example.com，而打开后仍正确显示归档 12306。归属选择未串到新任务，但历史元数据有误，应由持久任务状态更新卡片，不从首个 open 调用恢复最终 URL。

4. **P2：缩略图与归档截图的比例/裁切异常。** 12306 归档截图只保留放大的上方区域，刷新与重开旧卡片后仍可复现；新双页任务的百度缩略图也只显示局部。已记录截图和 Viewer canvas 尺寸，尚未确定根因。需核对 CDP viewport/DPR/clip.scale、全局桌面对远端窗口的影响及缩略图/归档采样路径，验证完整视口与输入坐标使用同一几何关系。不能仅用 CSS 放大按钮解释当前未主动开启放大时的异常。

5. **待复测：12306 导航的命令响应超时。** B 任务最终成功，Agent 表示 navigate 返回 Gateway 超时，随后 tabs/snapshot 确认 URL/标题。仅出现一次，尚未取得服务端该调用的耗时和异常日志；记录为待定位问题，不把它判为页面打不开，也不冒称已经解决。

### 本轮边界与交付

本轮是桌面 Chrome 的人工操作验收，不是全部故障场景的 E2E 认证。未覆盖 OneClaw Channel canonical Session 下断开所有客户端后的 durable handback、Gateway/Wrapper/Chromium 重启、30 分钟空闲自动回收、上传下载/系统弹框、账号 Cookie 隔离、容量压力和 iOS/Android 原生前后台。临时 390px 视口覆盖未在实际页面尺寸中生效，不能声称手机尺寸验收通过；DevTools 打开后约 1118px 的窄窗口能显示工作画面。当前多任务仍共享浏览器 Profile；B 百度建议中能看到 A 的搜索历史，任务页面隔离不等于账号/历史隔离。

本轮只新增验收记录和截图，未修改功能代码或部署实例。A 的人工控制已交还；B 的旧 12306 页已归档，新双页任务的控制已交还。原有工作未被删除或关闭。截图位于 `docs/browser-acceptance-2026-09-30/`：

- `a-human-input.jpg`、`a-refresh-paused.jpg`、`a-handback-waiter.jpg`：输入、刷新暂停、活跃等待器交还。
- `b-independent-12306.jpg`、`second-viewer-read-only.jpg`：任务页面隔离和第二 Viewer 只读。
- `share-global-mismatch.jpg`：全局分享的标题与桌面内容不一致。
- `b-archived-frame.jpg`、`b-old-card-pinned.jpg`：归档画面裁切及卡片 URL 不一致。
- `b-multi-example.jpg`、`b-multi-handback-input.jpg`：双页切换和交还前输入。
- `a-no-waiter-handback.jpg`：没有存活等待器时的交还状态。

## 16. 画面裁切、闪烁与资源操作收敛（2026-09-30）

用户反馈右侧只有网页的一部分，独立打开完整浏览器时闪烁，并要求将保留/关闭操作收到“更多”。本轮针对这些问题修改 Template 和 Web；前一节的分享身份、无等待器续跑、历史卡片元数据问题仍需分别处理，不能因画面链路修正而标记全部验收通过。

右侧是任务页面的内容视口采集，Chrome 原生标签栏与可编辑地址栏不在页面 surface 内。因此，原生工具栏缺失和网页本身被裁切是两个不同问题：前者是采集范围，后者是缺陷。保留任务自己的标签页与只读网址，避免通过完整桌面切换到其他任务；本轮没有伪装一个可编辑但不执行导航的地址框，也没有扩展任务导航权限。

定位到截图参数的问题：Wrapper 的页面池和旧截图 helper 都把 `Page.captureScreenshot.clip.scale` 用于缩略图/大图缩放。Chromium 的截图实现会通过 DeviceEmulationParams 修改 viewport 并临时 SetSize，截图结束再恢复原状态；两个读取入口的重叠截图会干扰 headed 浏览器与 VNC，可能恢复对方的临时尺寸。实际验收中的完整桌面闪烁、缩略图裁切、不同入口尺寸异常与此机制一致；移除这一副作用后仍需要在新部署中复验，不能将源码定位当作已完成线上对比。[Chromium PageHandler 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc)。

修改：

- 截图不再设置 clip，不修改浏览器视口，采集完整可见页面；大帧通过有限次数降低 JPEG 质量保持原传输上限，始终不将整页重新缩到浏览器渲染器里。
- Web 与移动端共享的 Runtime task Viewer 仅在图片尺寸变化时调整 canvas，避免每帧清空 surface；Runtime 只在任务/选择/控制状态变化时重建标签按钮，保留焦点。
- Web 任务 Viewer 和旧完整窗口组件的页面管理操作均收进“更多”；移除常驻的“空闲后自动释放 / 取消保留 / 关闭任务网页”横条。“取消保留”改成更明确的“恢复自动清理”。
- 保留后台回收机制，以及已接管页面的未提交编辑保护。用户只有需要稍后保留页面、提前回收页面时才使用菜单；关闭保留确认与最后截图，登录资料仍持久化。
- 当前任务网址标为只读，可查看完整显示值；人工接管、交还、画面大小、返回聊天仍是主要入口。

验证：页面池并发缩略图/大图不再设置 clip 或执行 Emulation/resize，输入坐标仍对应原页面；大图降质量次数与大小上限；新帧保留 canvas 和标签按钮；旧任务输入及迟到回调隔离测试均通过。Web 30 项 Browser 测试、TypeScript 和定向 ESLint 通过。本地改动需要重新构建并部署 Template 镜像和 Web，才能复验当前测试实例的视觉效果；不改变部署配置或重启现有实例。

## 17. 验收遗留问题修复（2026-09-30）

本轮修复验收中剩余的三类身份/状态问题，并补齐导航请求的截止时间：

- **交还后无需手动再发“继续”**：任务级人工 lease 拦住 Browser 调用时，即使 Runtime 全局仍为 `ai`，也记录当前 Run / Tool Call 为任务的待续跑工作。交还仍先唤醒存活的 `browser_use wait`；没有 waiter 时持久化 handoff 意图。Canonical OneClaw Session 继续通过已有 Channel API 的 Run 检查与幂等入场。当前 Web 的 authenticated owner Dashboard Session 使用已有 native `chat.send`，经 loopback + instance secret 的 Wrapper 适配；注册表验证 owner 工具上下文、原 Run 已结束、未取消、无已观察到的更新 Run。请求只允许携带 handoffId，目标会话及固定幂等 Run ID 来自注册表。SDK 的 `runtime.gateway` 对第三方插件有限制，因此不直接调用它，也不将 Dashboard ID 冒充 Channel Session。工具工厂上下文没有 runId，wait 从当前 prompt 的可信 Run 关联；思考阶段的接管也保留续跑状态。原执行仍活跃时不补发竞争 Run；不确定回执重用同一幂等 ID。
- **独立窗口不再跟随全局前台页**：`browser_use share` 从可信工具上下文获取当前任务，链接携带 `sessionKey + browserTaskId`。Web 验证两个 selector，再通过现有 owner-checked runtime-session API 换取指向 `/browser/?…` 的短期登录票据。Inline 打开和“更多 → 在新窗口打开”都传递同一精确任务 ID。Wrapper 将 Dashboard / Channel 身份分别交给同一个 task authority，不抢桌面焦点。无效或已释放 selector 也始终进入 scoped viewer，绝不回退 VNC。旧 workspace-only 入口显示回聊天选择具体任务的提示；Runtime 管理员直接访问 `/browser/` 的桌面诊断入口保留。
- **历史卡片不再回退首个 open 的 example.com**：可见卡片从精确 Tool Call 所属任务读取最终 displayUrl，优先于不完整 transcript 的首个 open 结果。即使已有持久 screenshot 或归档图片暂不可读，也读取只读任务 metadata。缓存保存 displayUrl，离屏卡片不查询，结束卡片不持续轮询；其他 Session 的 metadata 不会改写标题。Web 缩略帧大小上限对齐 Runtime 的 700000 字符限制，避免完整视口截图被客户端错误拒绝。
- **导航不再与自己的请求超时抢跑**：固定 OpenClaw `2026.7.1-2` 的 `browserNavigate` 请求原为 20 秒，与 Playwright 的默认导航截止时间相同，CDP 建连、重定向安全检查及响应序列化可能使请求先退出。本轮对受管 OneClaw Browser 的本地请求留 60 秒收尾时间，内部导航仍保持原 20 秒截止时间；不延长页面操作、不重试已经产生效果的导航。非 OneClaw 浏览器保持原值。Docker patch 校验唯一编译锚点与 exact version，已对 npm 原版 pinned bundle 实际执行验证。

上一轮已修复的 captureScreenshot.clip 引发 renderer 临时缩放/还原闪烁、相同尺寸 canvas 反复清空，以及页面保留/关闭迁入“更多”保持生效。浏览器任务画面显示当前任务的网页及自己的标签/网址头部；不会捕获或操纵其他会话的 Chrome 原生标签栏。

验证：Browser 插件 72 项，Template 全量 324 项，直接加载当前插件源码的 Wrapper 生命周期集成 5 项，Web Browser 34 项均通过；Template syntax、Web TypeScript / 修改文件 ESLint 通过。新增用例覆盖 lease 阻挡且无 waiter 的交还、原 Run 未结束不续跑、取消/新 Run 抑制旧意图、回执丢失幂等重试、精确 task 身份贯穿 resolve/preview/control/manage、无效链接不连接共享桌面、已有截图和图片失效时的历史网址恢复。

本轮 Chrome 只读检查确认 185 测试站尚在旧前端：B 的旧卡片仍为 example.com，而精确任务页为 12306，“更多”尚无新增的精确任务新窗口入口。因此本节的“通过”指代码与自动化验证，不代表测试环境部署后的验收。需要更新 Template 镜像及 Web 后，重跑上述三个失败场景和实时画面的闪烁/完整视口检查。API / iOS / Android 无须为本轮修改协议或发布；原生任务 viewer 的 sessionId / toolCallId 入口兼容保留，移动端新分享 URL 可通过 Web 精确任务入口打开。

## 18. 输入与画面链路整体改造（2026-09-30）

人工接管时的瓶颈横跨传输、渲染与任务调度：原输入逐次经过 Gateway RPC、插件 loopback、lease admission、CDP 与 completion；画面按 200ms 截图；同一 Chrome 窗口的后台标签不能持续产生 screencast 帧。只缩短轮询周期会增加负载，不能消除后台页面停帧。

本轮使用持久 CDP Page.screencastFrame 推送当前任务页面，立即 ACK，保留最新帧、丢弃积压帧；现有截图只作恢复兜底。任务切页、导航、窗口尺寸变化与关闭均重新验证目标身份。受管新页面使用独立 Chrome 窗口，仅最大化自己新建的窗口，并关闭后台渲染节流；不激活其他任务。固定 OpenClaw 版本的 native creator patch 继续校验唯一编译锚点，其他浏览器行为保持原值。

人工输入在现有 owner ticket 绑定的任务媒体 WebSocket 上显式协商，顺序编号与 ACK；lease 获取、交还仍走原任务 authority。每次输入仍验证 controller token、control epoch、task generation、目标与帧文档几何。仅合并尚未发送的相邻文字、移动和滚动，保留按下/抬起与键盘顺序；丢失 ACK 不重发已执行输入。接管成功后取真实时间晚于 grant 的新帧，避免第一下输入用到旧画面。Web 与 Runtime viewer 使用相同输入实现；旧客户端仍是只读媒体，API 的现有二进制代理无须变更。

同尺寸 canvas 保留 surface，不调整浏览器渲染器尺寸。新增全选、撤销/重做、退格与定位键，快捷键作用于当前任务网页；不会把共享桌面的系统剪贴板当作任务隔离剪贴板。

隔离验证在 101 使用相同镜像、独立临时 Chromium profile 与无网络容器，输入 A 时 B 保持前台：同窗口背景标签 12 次中缺失 6 次 screencast；改为独立窗口后 12 次均有帧，输入到下一画面的中位数 35ms、P95 63ms，顺序与另一任务未被修改检查通过。此数据只衡量 renderer/CDP，不包含真实 Web/API 链路，不能代替部署后 Chrome 验收。可复现脚本为 `scripts/verify-browser-latency-live.mjs`。

自动化验证：Template 全量 331 项、插件 73 项、Web Browser 34 项、当前插件源码生命周期集成 5 项通过；Web TypeScript、定向 ESLint 与 Template syntax 通过。部署与真实 Chrome 结果在实际完成后补录。
