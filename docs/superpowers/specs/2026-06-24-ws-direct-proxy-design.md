# 设计:移除 ws-hub 前端多路复用,改 WS 反代直连

日期:2026-06-24
状态:待执行

## 问题

ws-hub 把所有前端 client 多路复用到**单个** gateway WS 连接,且本地截获 `connect` 握手用 `cachedHelloOk` 回应。这与 openclaw 的 per-client WS 模型根本冲突:

- `EventFrameSchema = { type, event, payload?, seq?, stateVersion? }`(`additionalProperties:false`)—— **event 帧不带目标 client/session 字段**,路由完全靠连接级状态。
- `OpenClawClient` 是 per-client 订阅(`subscribedSessions` + `sessions.messages.subscribe`)。
- ws-hub 合并连接 → gateway 只认一个 client(多端 presence 错乱)、event 全广播(订阅串台)、per-client 功能(订阅/agent/会话操作)失效。
- 铁证:ws-hub 最近 8 个 commit 全是 `fix(ws-hub)`(协议层补丁),永远追不齐——架构上无法用一个共享连接表达 N 个独立 client。

## 方案

**每个前端 client 直连 gateway**(各自 WS 握手 + 订阅 + 收自己的 event);wrapper 只做 WS 反向代理 + 注入 bearer,不做应用层多路复用。openclaw gateway 本就为多 client 直连设计。

### Auth 流程(已验证可行)
- 浏览器 `wss://domain/openclaw?token=<GATEWAY_TOKEN>`(OpenClawClient 现状,`instance.gatewayToken` = wrapper GATEWAY_TOKEN)。
- wrapper `isAuthed`:`queryTokenMatchesGateway` 比对 GATEWAY_TOKEN(已存在)或 cookie/Bearer secret。
- 反代:`proxy.ws(req,socket,head)` + `proxyReqWs` 注入 `Authorization: Bearer GATEWAY_TOKEN` + 剥离 forwarded 头(沿用 `dropForwardedOnProxyReq`,让 gateway 视为本地直连 → `allowInsecureAuth` bypass 生效)。
- gateway 收到 Bearer + 真实 client 握手 → 每 client 独立 presence/订阅。

### wrapper 自身 RPC(whatsapp-login 等)
gateway 不暴露 web.login HTTP(已确认),所以 wrapper 仍需一个到 gateway 的 WS 连接做 RPC。从 ws-hub **拆出精简版**:`gateway-rpc.js`——只做 connect 握手 + `rpcGateway(method,params)`,不处理前端 client。whatsapp-login 端点继续用它(接口不变)。

## 改动

### openclaw-template
1. **新建 `src/lib/gateway-rpc.js`**:从 ws-hub 提取的单连接 gateway WS 客户端(connect 3-step 握手 + `rpcGateway` + 重连)。供 whatsapp-login 等端点用。
2. **`src/lib/ws-hub.js`**:移除前端多路复用(wss/handleUpgrade/broadcast/reqOrigin/cachedHelloOk 本地握手/cleanupClient)。或直接删除,职责并入 gateway-rpc。
3. **`src/lib/routes/repair.js`**:whatsapp-login 的 `wsHub.rpcGateway` 改为 `gatewayRpc.rpcGateway`(接口不变)。
4. **`src/sidecar.js`**:
   - `createProxyServer` 加 `ws: true`。
   - 加 `proxy.on("proxyReqWs", ...)` 注入 Bearer + 剥离 forwarded(沿用 `dropForwardedOnProxyReq`)。
   - `server.on("upgrade")`:改为 `isAuthed(req)` 后 `proxy.ws(req,socket,head)`(替代 `wsHub.handleUpgrade`)。
   - `wsHub` 替换为 `gatewayRpc`(精简单连接);`wsHub.start/restart/close` 调用点改 `gatewayRpc`。
5. **CLAUDE.md gotcha #6**:更新——WS 不再走 ws-hub 多路复用,改反代直连;每 client 独立握手/订阅。

### oneclaw_web
无需改动——`OpenClawClient` 本就是 per-client 直连模型(`wss://domain/openclaw?token=`),反代后自然每 client 独立。ws-hub 移除后它的连接更正确(event 不再串台)。

## 验证(本地,先做)

起本地 gateway(已有 /tmp/oc-qrtest 配置),写脚本开**两个** WS client:
1. 各自完成 connect 握手 → gateway 应认两个独立 client(helloOk 里 client 标识不同 / presence 计数 +1)。
2. 各自 `sessions.messages.subscribe` 不同 session → 给 session A 发消息 → 只有 client A 收到 event(client B 不收)。**这是核心验证:event 按 client 订阅隔离,不串台。**

若验证通过,说明直连模型正确,ws-hub 确是根因,改造可行。

## 风险

- **Control UI(`/openclaw`)**:也走反代直连。它本就是 openclaw 官方前端,直连是它的预期模型,应更正确(之前 ws-hub 截获反而可能让它异常)。
- **连接数**:每浏览器 tab 一个 gateway 连接。gateway 设计支持;Railway 实例并发用户有限,不是问题。
- **whatsapp-login**:改造后仍用 wrapper 自身 RPC 连接,端点契约不变,oneclaw_web QrBindModal 无需改。
- **ws-hub 移除范围**:rpcGateway/selfPending/握手逻辑迁到 gateway-rpc.js;前端相关全删。

## 不做(YAGNI)
- 不做 ws-hub 的"按订阅过滤 event"改造(帧无 target 字段,不可行,已论证)。
- 不改 oneclaw_web OpenClawClient(它本就直连模型)。
- 不动 HTTP 反代(只动 WS upgrade 路径)。
