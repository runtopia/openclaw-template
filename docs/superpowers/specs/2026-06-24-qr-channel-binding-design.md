# 设计:微信 / WhatsApp 扫码绑定通道

日期:2026-06-24
状态:已批准设计,待写实现计划

## 背景与问题

WhatsApp(`@openclaw/whatsapp`)和微信(第三方 `@tencent-weixin/openclaw-weixin`,channel/plugin id 均为 `openclaw-weixin`)是 `kind: 'qr'` 通道:配置阶段只「启用」,真正绑定要在运行时扫二维码。

现状缺口:

- **wrapper(openclaw-template)**:`/repair/*` 是纯 JSON/SSE API,没有暴露二维码的端点。gateway 把 stdout 每行写入 500 行 ring buffer(`src/lib/gateway.js` 的 `appendLog`),二维码就在里面,但无人取用。
- **oneclaw_web**:`src/lib/channels.ts` 早已把 whatsapp/wechat 标为 `kind: 'qr'`,注释写明「scan a QR code from the dashboard」;但 `ChannelsModal.tsx` 里 qr 通道**只有一个启用勾选框**(勾上→PATCH `/api/deploy/managed`→设 `WHATSAPP_ENABLED=1`/`WECHAT_ENABLED=1`→Railway 重新部署),**没有任何真正扫码的界面**。

目标:让用户启用 qr 通道、实例重新部署起来后,能在 oneclaw_web dashboard 里扫码完成绑定。

## 关键约束与已知未知

1. **同一份凭证不能两个进程同时连**(baileys 类 WhatsApp)。因此**不**另起 `openclaw channels login` 进程,而是复用 gateway 自身启动时(通道 enabled 但未登录)反复打印的二维码。
2. **二维码持久化依赖 STATE_DIR 落到 /data volume**。本仓库同期修复了 `start.sh` 未 export `OPENCLAW_STATE_DIR`/`OPENCLAW_WORKSPACE_DIR` 的问题(凭证写在 `STATE_DIR/credentials/`),扫码成功后的会话才能跨重新部署保留,不必反复重扫。
3. **【已知未知】真实二维码的日志格式**:开发机未装这两个插件(它们在镜像 `/opt/openclaw-plugins`),无法本地确认 gateway 实际打印的是 ANSI/ASCII 二维码块,还是带原始 payload 串(如 WhatsApp 的 `2@...`)。这是实现计划的**第一个验证步骤**:在跑起来的容器里 `read_logs` 看真实输出,据此定解析正则。端点设计对两种格式都兼容。

## 总体架构

```
oneclaw_web (Next.js 控制台)
  └─ QrBindModal (新增, 轮询)
        │  GET https://<domain>/repair/qr?channel=whatsapp
        │  Authorization: Bearer <instance.secret>
        ▼
wrapper (openclaw-template, /repair 路由)
  └─ GET /repair/qr  ← 读 gateway.js 缓存的「每通道二维码状态」
        ▲
gateway.js appendLog(line)
  └─ 识别二维码块 / 登录成功行 → 更新 channelQrState[channel]
        ▲
openclaw gateway run (子进程 stdout)
```

## 组件设计

### A. wrapper — gateway.js:二维码状态捕获

在 `gateway.js` 内维护模块级状态:

```
channelQrState = {
  whatsapp: { status, qr, raw, updatedAt },
  'openclaw-weixin': { ... },
}
```

- `status`: `'waiting'`(已启用、尚未见到二维码) | `'qr'`(有可扫二维码) | `'connected'`(检测到登录成功)。
- `qr`: 捕获到的二维码文本块(ASCII/ANSI,回退渲染用)。
- `raw`: 若日志中能提取到原始 payload 串则填入(优先渲染用);否则为 null。
- `updatedAt`: 时间戳。

`appendLog(line)` 增加轻量解析(具体正则在验证步骤后确定):

- 命中某通道的二维码起止标记 → 累积 `qr` 文本块、设 `status='qr'`、若行内含 payload 串则填 `raw`。
- 命中登录/连接成功标记 → `status='connected'`、清空 `qr`。
- 解析逻辑独立成纯函数(输入若干日志行,输出状态更新),便于单测。

新增导出 `getChannelQrState(channel)`。

> 设计取舍:解析放在 `appendLog`(单点、随日志流增量更新),而非在端点里每次重扫整个 buffer——避免 500 行重复扫描,且能稳定捕获「成功」这种瞬时行。

### B. wrapper — repair.js:`GET /repair/qr`

```
GET /repair/qr?channel=whatsapp | wechat
Authorization: Bearer <secret>        # 复用 requireRepairAuth
→ 200 { channel, status, qr, raw, updatedAt }
→ 400 { error } 当 channel 非法
```

- 接受前端友好别名 `wechat` → 内部映射到 channel id `openclaw-weixin`。
- 通道未在配置里启用时:返回 `status:'disabled'`,前端提示「请先在渠道配置里启用」。
- 仅暴露这两个 qr 通道,白名单校验。

### C. oneclaw_web — openclaw-repair.ts

新增:

```
export async function repairGetChannelQr(domain, secret, channel):
  Promise<{ channel, status, qr, raw, updatedAt }>
```

复用现有 `repairFetch`(Bearer secret、15s 超时)。

### D. oneclaw_web — QrBindModal(独立扫码 Modal)

- 入口:`ChannelsModal.tsx` 中,qr 通道**已启用**时,在该通道行加「扫码绑定」按钮 → 打开 `QrBindModal`。
- 行为:
  - 打开后每 ~2s 轮询 `repairGetChannelQr`。
  - **双路渲染**:`raw` 有值 → 用 `qrcode` 库渲染成 canvas(清晰、易扫);否则回退把 `qr` 文本块用等宽/终端样式 `<pre>` 显示。
  - `status==='connected'` → 显示 ✅「已连接」,停止轮询。
  - `status==='disabled'` / gateway 未就绪 / 暂无二维码 → 各自对应提示;二维码会过期,提供「刷新」。
- 依赖:oneclaw_web 新增 `qrcode` npm 依赖(当前未安装)。
- i18n:复用现有 `useI18n`,中英文文案。

## 数据流(扫码时序)

1. 用户在 ChannelsModal 勾选启用 whatsapp → 保存 → Railway 重新部署(已有流程)。
2. 实例起来,gateway 加载插件、通道 enabled 但未登录 → 打印二维码到 stdout → `appendLog` 捕获 → `channelQrState.whatsapp = {status:'qr', ...}`。
3. 用户点「扫码绑定」→ QrBindModal 轮询 `/repair/qr?channel=whatsapp` → 渲染二维码。
4. 用户手机扫码 → gateway 打印登录成功 → `appendLog` 置 `connected` → 下次轮询前端显示 ✅。
5. 凭证写入 `STATE_DIR/credentials/`(在 /data volume 上,跨重新部署保留)。

## 错误处理

| 情况 | 端点返回 | 前端表现 |
| --- | --- | --- |
| channel 非法 | 400 | 不该发生(白名单按钮) |
| 通道未启用 | `status:'disabled'` | 提示先到渠道配置启用 |
| gateway 未就绪 | repairFetch 抛错/超时 | 「实例启动中,请稍候」+ 重试 |
| 已启用但还没二维码 | `status:'waiting'` | loading + 「正在生成二维码」 |
| 二维码过期 | 仍 `status:'qr'`(旧) | 提供「刷新」手动重新轮询 |

## 测试

- **wrapper**:对二维码解析纯函数写单测——喂入「真实容器里抓到的样例日志行」(waiting→qr→connected 三态),断言状态机正确。
- **oneclaw_web**:手测——启用通道、部署、打开 Modal、确认二维码渲染与连上后 ✅。
- 端点鉴权:无 Bearer / 错误 secret → 401(复用 requireRepairAuth 现有行为)。

## 范围外(YAGNI)

- 不为 token 类通道(telegram/discord/feishu)做任何扫码 UI。
- 不在 wrapper 内做 HTML 页面(扫码 UI 只在 oneclaw_web)。
- 不另起独立登录进程 / 不引入 xterm 全终端。
- 不做二维码主动「登出/解绑」(后续需要再议)。

## 跨仓改动清单

**openclaw-template:**
- `src/lib/gateway.js`:二维码状态捕获 + `getChannelQrState`(解析纯函数可拆到独立文件便于单测)。
- `src/lib/routes/repair.js`:`GET /repair/qr` + 端点列表更新。
- 单测文件。

**oneclaw_web:**
- `src/lib/openclaw-repair.ts`:`repairGetChannelQr`。
- `src/app/dashboard/_components/modals/QrBindModal.tsx`:新增。
- `src/app/dashboard/_components/modals/ChannelsModal.tsx`:qr 通道行加「扫码绑定」入口。
- `package.json`:新增 `qrcode` 依赖。
- i18n 文案。

## 实现计划第一步(必须最先做)

在一个已部署/本地容器实例上启用 whatsapp(及微信),`read_logs` 抓取 gateway 实际打印的二维码与登录成功日志原文,据此确定:
1. 二维码是 ANSI 块还是含原始 payload 串(决定 `raw` 能否填、双路渲染哪路为主)。
2. 起止标记 / 成功标记的正则。

后续解析、端点、前端渲染都以此为准。
