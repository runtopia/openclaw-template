# 微信 / WhatsApp 扫码绑定通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户启用 WhatsApp / 微信 qr 通道、实例部署后,能在 oneclaw_web dashboard 扫码完成绑定。

**Architecture:** wrapper(openclaw-template)从 gateway stdout 日志里捕获每通道的二维码状态,经新增 `GET /repair/qr` 暴露(Bearer secret 鉴权);oneclaw_web 经服务端 API 路由(持有 secret)中转,在独立 `QrBindModal` 里轮询并双路渲染二维码(payload→qrcode 库 canvas,回退 ASCII 文本块)。不另起 login 进程,复用 gateway 自身打印的二维码以避免凭证抢占。

**Tech Stack:** Node 22 ESM(wrapper,零 devDep,测试用内置 `node --test`)、Express、Next.js 16 + React + TypeScript(oneclaw_web)、`qrcode` 库。

**Spec:** `docs/superpowers/specs/2026-06-24-qr-channel-binding-design.md`

**两个仓库:**
- wrapper:`/Users/luopeng/vue/openclaw-template`
- oneclaw_web:`/Users/luopeng/vue/oneclaw_web`(分支自行新建,如 `feat/qr-channel-binding`)

---

## Phase 0:确认真实二维码日志格式(必须最先做,人工)

解析器用「QR 字形行」启发式检测(与具体插件无关),但**通道归属标记**和**登录成功标记**的实际字符串只能在跑起来的容器里确认。本阶段产出会回填到 Task 2 的 `CHANNEL_PATTERNS`。

### Task 0:抓取真实二维码与登录日志

**Files:** 无(产出记录,贴进本计划/PR 描述)

- [ ] **Step 1: 在一个已部署实例上启用 whatsapp + wechat**

oneclaw_web dashboard 渠道配置勾选启用,等待 Railway 重新部署完成。

- [ ] **Step 2: 抓 gateway 日志**

```bash
curl -s -H "Authorization: Bearer <instance.secret>" \
  "https://<domain>/repair/logs?n=500"
```

- [ ] **Step 3: 记录三类样本**

从输出里摘抄并记录(替换 Task 2 默认值前必须确认):
1. 二维码块上面的「上下文行」长什么样(是否含 `whatsapp` / `weixin` / `微信` 字样、有无插件前缀如 `[whatsapp]`)。
2. 二维码块本身用的字符(`█▀▄` 等字形,还是别的)。
3. 登录/连接成功那一行原文(关键词:`connected` / `logged in` / `ready` / `登录成功` 等)。
4. 是否存在含原始 payload 串的行(如 `qr: 2@xxxx`)——决定 `raw` 能否填。

- [ ] **Step 4: 若实际标记与 Task 2 默认正则不符,在实现 Task 2 时据此调整 `CHANNEL_PATTERNS`**

只改 `CHANNEL_PATTERNS` 这一个对象;字形检测与状态机逻辑无需动。

---

## Phase 1:wrapper 后端(openclaw-template)

工作目录:`/Users/luopeng/vue/openclaw-template`(已在 `feat/qr-channel-binding` 分支)。

### Task 1:加测试脚本

**Files:**
- Modify: `package.json`(scripts)

- [ ] **Step 1: 加 test 脚本**

把 `package.json` 的 `scripts` 改为含:

```json
"test": "node --test test/"
```

(保留现有 dev/start/lint。)

- [ ] **Step 2: 提交**

```bash
git add package.json
git commit -m "chore: add node --test runner script"
```

### Task 2:二维码解析器(纯模块 + 单测)

**Files:**
- Create: `src/lib/channel-qr.js`
- Test: `test/channel-qr.test.js`

- [ ] **Step 1: 写失败测试**

`test/channel-qr.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isQrGlyphLine, stripAnsi, createQrTracker } from "../src/lib/channel-qr.js";

// 构造一段假二维码块(字形行)
const QR_ROW = "█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█";
function qrBlock(n = 25) { return Array.from({ length: n }, () => QR_ROW); }

test("stripAnsi 去掉 ANSI 颜色码", () => {
  assert.equal(stripAnsi("\x1b[32m█▀█\x1b[0m"), "█▀█");
});

test("isQrGlyphLine: 字形行为 true,普通日志为 false", () => {
  assert.equal(isQrGlyphLine(QR_ROW), true);
  assert.equal(isQrGlyphLine("[gateway] starting whatsapp channel"), false);
  assert.equal(isQrGlyphLine(""), false);
});

test("tracker: 上下文行 + 二维码块 + 普通行 → status=qr", () => {
  const tr = createQrTracker();
  tr.ingest("[whatsapp] scan this QR code to log in");
  for (const row of qrBlock()) tr.ingest(row);
  tr.ingest("[gateway] waiting for scan...");   // 非字形行,触发 flush
  const s = tr.get("whatsapp");
  assert.equal(s.status, "qr");
  assert.ok(s.qr.includes("█"));
});

test("tracker: 登录成功行 → status=connected 并清空 qr", () => {
  const tr = createQrTracker();
  tr.ingest("[whatsapp] scan this QR");
  for (const row of qrBlock()) tr.ingest(row);
  tr.ingest("noise");
  tr.ingest("[whatsapp] connection open, logged in");
  const s = tr.get("whatsapp");
  assert.equal(s.status, "connected");
  assert.equal(s.qr, null);
});

test("tracker: 原始 payload 串被提取到 raw", () => {
  const tr = createQrTracker();
  tr.ingest("[whatsapp] qr: 2@AbC123XyZ");
  const s = tr.get("whatsapp");
  assert.equal(s.status, "qr");
  assert.equal(s.raw, "2@AbC123XyZ");
});

test("tracker: 微信别名渠道 id 为 openclaw-weixin", () => {
  const tr = createQrTracker();
  tr.ingest("[微信] 请扫码登录");
  for (const row of qrBlock()) tr.ingest(row);
  tr.ingest("done");
  assert.equal(tr.get("openclaw-weixin").status, "qr");
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/channel-qr.test.js`
Expected: FAIL（`Cannot find module .../src/lib/channel-qr.js`）

- [ ] **Step 3: 写实现**

`src/lib/channel-qr.js`:

```js
// 从 gateway stdout 日志流里捕获各 qr 通道的二维码状态。
//
// 设计:二维码块用「字形行」启发式识别(与插件无关);通道归属与登录成功
// 标记集中在 CHANNEL_PATTERNS,Phase 0 在真实容器里确认后只改这一处。

const QR_GLYPHS = new Set(["█", "▀", "▄", "▐", "▌", "░", "▒", "▓", " "]);
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

export function isQrGlyphLine(line) {
  const s = stripAnsi(line).replace(/\s+$/, "");
  if (s.trim().length < 8) return false; // 太短不可能是二维码一行
  let glyph = 0;
  let total = 0;
  for (const ch of s) {
    total++;
    if (QR_GLYPHS.has(ch)) glyph++;
  }
  return total > 0 && glyph / total >= 0.8;
}

// 通道归属/成功/payload 标记。Phase 0 确认后按需调整本对象(仅此一处)。
export const CHANNEL_PATTERNS = {
  whatsapp: {
    contextRe: /\bwhatsapp\b/i,
    connectedRe: /\bwhatsapp\b.*(connected|logged[ _-]?in|connection open|ready|登录成功)/i,
    rawRe: /\bwhatsapp\b.*\bqr\b\s*[:=]\s*(\S+)/i,
  },
  "openclaw-weixin": {
    contextRe: /(weixin|wechat|微信)/i,
    connectedRe: /(weixin|wechat|微信).*(connected|logged[ _-]?in|ready|登录成功|扫码成功)/i,
    rawRe: /(weixin|wechat|微信).*\bqr\b\s*[:=]\s*(\S+)/i,
  },
};

const MIN_QR_ROWS = 3;

export function createQrTracker(patterns = CHANNEL_PATTERNS) {
  const state = {};
  for (const ch of Object.keys(patterns)) {
    state[ch] = { status: "waiting", qr: null, raw: null, updatedAt: 0 };
  }
  let ctx = null; // 当前通道上下文(由最近一条上下文行设定)
  let buf = []; // 累积中的二维码字形行

  function flush() {
    if (ctx && buf.length >= MIN_QR_ROWS) {
      state[ctx] = { ...state[ctx], status: "qr", qr: buf.join("\n"), updatedAt: Date.now() };
    }
    buf = [];
  }

  function ingest(rawLine) {
    const line = String(rawLine);
    if (isQrGlyphLine(line)) {
      buf.push(stripAnsi(line).replace(/\s+$/, ""));
      return;
    }
    if (buf.length) flush(); // 非字形行结束当前块

    for (const [ch, p] of Object.entries(patterns)) {
      if (p.connectedRe.test(line)) {
        state[ch] = { status: "connected", qr: null, raw: null, updatedAt: Date.now() };
        ctx = ch;
        return;
      }
      const m = p.rawRe.exec(line);
      if (m) {
        state[ch] = { ...state[ch], status: "qr", raw: m[1], updatedAt: Date.now() };
        ctx = ch;
        return;
      }
      if (p.contextRe.test(line)) {
        ctx = ch;
        return;
      }
    }
  }

  return {
    ingest,
    get(ch) {
      return state[ch] ? { channel: ch, ...state[ch] } : null;
    },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/channel-qr.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add src/lib/channel-qr.js test/channel-qr.test.js
git commit -m "feat(channel-qr): add gateway-log QR state tracker with tests"
```

### Task 3:把 tracker 接进 gateway.js

**Files:**
- Modify: `src/lib/gateway.js`

- [ ] **Step 1: 引入 tracker**

在 `src/lib/gateway.js` 顶部 import 区加:

```js
import { createQrTracker } from "./channel-qr.js";
```

- [ ] **Step 2: 在 createGatewayManager 内创建 tracker 并接入 appendLog**

把现有:

```js
  const LOG_BUFFER_MAX = 500;
  const logBuffer = [];
  function appendLog(line) {
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }
```

改为:

```js
  const LOG_BUFFER_MAX = 500;
  const logBuffer = [];
  const qrTracker = createQrTracker();
  function appendLog(line) {
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    try { qrTracker.ingest(line); } catch { /* 解析失败不影响日志 */ }
  }
```

- [ ] **Step 3: 在返回对象里暴露 getChannelQrState**

找到 createGatewayManager 的 return 对象里 `getRecentLogs: (n = 100) => logBuffer.slice(...)` 那一行,在其后加一行:

```js
    getChannelQrState: (channel) => qrTracker.get(channel),
```

- [ ] **Step 4: 语法检查**

Run: `node -c src/lib/gateway.js`
Expected: 无输出(通过)

- [ ] **Step 5: 提交**

```bash
git add src/lib/gateway.js
git commit -m "feat(gateway): feed stdout into QR tracker, expose getChannelQrState"
```

### Task 4:`GET /repair/qr` 端点

**Files:**
- Modify: `src/lib/routes/repair.js`

- [ ] **Step 1: 在 createRepairRouter 内,GET /logs 路由附近加 /qr 路由**

参照同文件 `GET /logs`(用 `gatewayManager`)与 `GET /config`(用 `configFilePath()`、`fs`)的闭包变量。新增:

```js
  // GET /qr?channel=whatsapp|wechat — 返回该 qr 通道最近的二维码状态
  const QR_CHANNEL_ALIAS = { whatsapp: "whatsapp", wechat: "openclaw-weixin" };
  router.get("/qr", requireRepairAuth, (req, res) => {
    const alias = String(req.query.channel || "");
    const channelId = QR_CHANNEL_ALIAS[alias];
    if (!channelId) {
      return res.status(400).json({ error: `unknown qr channel: ${alias}` });
    }
    // 配置里未启用 → disabled
    let enabled = false;
    try {
      const cfgPath = configFilePath();
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        enabled = !!cfg?.channels?.[channelId]?.enabled;
      }
    } catch { /* 读配置失败按未启用处理 */ }
    if (!enabled) {
      return res.json({ channel: alias, status: "disabled", qr: null, raw: null, updatedAt: 0 });
    }
    const st = gatewayManager.getChannelQrState(channelId)
      || { status: "waiting", qr: null, raw: null, updatedAt: 0 };
    res.json({ channel: alias, status: st.status, qr: st.qr, raw: st.raw, updatedAt: st.updatedAt });
  });
```

- [ ] **Step 2: 把 /qr 加进 GET / 的端点清单**

找到 `endpoints: ["GET /status", "GET /logs", ...]` 那一行,在数组里加 `"GET /qr"`。

- [ ] **Step 3: 语法检查**

Run: `node -c src/lib/routes/repair.js`
Expected: 无输出(通过)

- [ ] **Step 4: 跑全部单测确认未回归**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/routes/repair.js
git commit -m "feat(repair): add GET /repair/qr endpoint for channel QR state"
```

### Task 5:更新 wrapper 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 在 "Quirks & Gotchas" 末尾加一条**

```markdown
12. **二维码扫码绑定走日志捕获,不另起 login 进程** → WhatsApp/微信(`kind:qr`)的二维码由 gateway 自身在「通道 enabled 但未登录」时打印到 stdout;`gateway.js` 经 `channel-qr.js` 的 tracker 从日志流捕获每通道状态(waiting/qr/connected),`GET /repair/qr?channel=whatsapp|wechat` 暴露给 oneclaw_web。**不**调用 `openclaw channels login`——baileys 类通道同一凭证不能两个进程同时连。通道归属/成功标记的正则在 `channel-qr.js` 的 `CHANNEL_PATTERNS`,如插件升级改了日志格式只需调这一处。
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: document QR channel binding via log capture"
```

---

## Phase 2:oneclaw_web 前端

工作目录:`/Users/luopeng/vue/oneclaw_web`。先建分支:

```bash
cd /Users/luopeng/vue/oneclaw_web && git checkout -b feat/qr-channel-binding
```

### Task 6:加 qrcode 依赖

**Files:**
- Modify: `package.json`、`pnpm-lock.yaml`

- [ ] **Step 1: 安装**

```bash
cd /Users/luopeng/vue/oneclaw_web
pnpm add qrcode && pnpm add -D @types/qrcode
```

- [ ] **Step 2: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add qrcode dependency for QR rendering"
```

### Task 7:repair 客户端加 repairGetChannelQr

**Files:**
- Modify: `src/lib/openclaw-repair.ts`

- [ ] **Step 1: 在文件末尾(其他 repair* 函数旁)新增**

```ts
export interface ChannelQrState {
  channel: string;
  status: 'disabled' | 'waiting' | 'qr' | 'connected';
  qr: string | null;
  raw: string | null;
  updatedAt: number;
}

/** 读取某 qr 通道(whatsapp|wechat)当前二维码状态。 */
export async function repairGetChannelQr(
  domain: string,
  secret: string,
  channel: 'whatsapp' | 'wechat',
): Promise<ChannelQrState> {
  const data = await repairFetch(domain, secret, `qr?channel=${encodeURIComponent(channel)}`, 'GET');
  return data as ChannelQrState;
}
```

> 注:`repairFetch` 已在文件顶部定义(`https://${domain}/repair/${path}` + Bearer secret),`path` 带 query 字符串可直接拼。

- [ ] **Step 2: 类型检查**

Run: `cd /Users/luopeng/vue/oneclaw_web && pnpm exec tsc --noEmit`
Expected: 无与本文件相关的报错

- [ ] **Step 3: 提交**

```bash
git add src/lib/openclaw-repair.ts
git commit -m "feat(repair-client): add repairGetChannelQr"
```

### Task 8:Next API 路由中转(secret 留服务端)

**Files:**
- Create: `src/app/api/deploy/managed/channel-qr/route.ts`

- [ ] **Step 1: 写路由(参照 restart/route.ts 的鉴权+取 instance 模式)**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getUserInstance } from '@/lib/db';
import { verifyFirebaseIdToken } from '@/lib/api-auth';
import { repairGetChannelQr } from '@/lib/openclaw-repair';

/**
 * GET /api/deploy/managed/channel-qr?channel=whatsapp|wechat
 * 返回该 qr 通道当前二维码状态。secret 仅在服务端使用,不下发浏览器。
 * Auth: Firebase ID token。
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await verifyFirebaseIdToken(request);
    if (auth instanceof NextResponse) return auth;

    const channel = request.nextUrl.searchParams.get('channel');
    if (channel !== 'whatsapp' && channel !== 'wechat') {
      return NextResponse.json({ error: 'invalid channel' }, { status: 400 });
    }

    const instance = await getUserInstance(auth.uid);
    if (!instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }
    if (!instance.domain || !instance.secret) {
      return NextResponse.json({ error: 'Instance not ready' }, { status: 409 });
    }

    const state = await repairGetChannelQr(instance.domain, instance.secret, channel);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch QR' },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `cd /Users/luopeng/vue/oneclaw_web && pnpm exec tsc --noEmit`
Expected: 无与本文件相关的报错

- [ ] **Step 3: 提交**

```bash
git add src/app/api/deploy/managed/channel-qr/route.ts
git commit -m "feat(api): add channel-qr proxy route"
```

### Task 9:QrBindModal 组件

**Files:**
- Create: `src/app/dashboard/_components/modals/QrBindModal.tsx`

- [ ] **Step 1: 写组件**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { X, Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { authFetch } from '@/lib/auth-fetch';
import type { ChannelQrState } from '@/lib/openclaw-repair';

interface Props {
  channel: 'whatsapp' | 'wechat';
  label: string;
  onClose: () => void;
}

const POLL_MS = 2000;

export default function QrBindModal({ channel, label, onClose }: Props) {
  const { locale } = useI18n();
  const [state, setState] = useState<ChannelQrState | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function poll() {
    try {
      const res = await authFetch(`/api/deploy/managed/channel-qr?channel=${channel}`);
      const data: ChannelQrState = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error || 'failed');
      setError(null);
      setState(data);
      if (data.raw) {
        QRCode.toDataURL(data.raw, { margin: 1, width: 256 })
          .then(setDataUrl)
          .catch(() => setDataUrl(null));
      } else {
        setDataUrl(null);
      }
      if (data.status !== 'connected') {
        timer.current = setTimeout(poll, POLL_MS);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      timer.current = setTimeout(poll, POLL_MS);
    }
  }

  useEffect(() => {
    poll();
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const zh = locale === 'zh';
  const status = state?.status;

  return (
    <div className="fixed inset-0 bg-ink-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-ink-900 border border-white/10 rounded-2xl shadow-brand w-full max-w-md flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <span className="text-white font-medium">
            {zh ? `扫码绑定 ${label}` : `Scan to bind ${label}`}
          </span>
          <button onClick={onClose} className="text-ink-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-6 flex flex-col items-center justify-center min-h-[320px] text-center">
          {status === 'connected' ? (
            <div className="flex flex-col items-center gap-3 text-emerald-300">
              <CheckCircle2 className="w-12 h-12" />
              <p className="text-sm">{zh ? '已连接' : 'Connected'}</p>
            </div>
          ) : status === 'disabled' ? (
            <p className="text-sm text-ink-400">
              {zh ? '请先在「渠道配置」里启用此渠道' : 'Enable this channel in Channel Configuration first.'}
            </p>
          ) : dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt="QR code" className="w-64 h-64 bg-white rounded-lg p-2" />
          ) : state?.qr ? (
            <pre className="text-[6px] leading-[6px] font-mono bg-black text-white p-3 rounded-lg overflow-auto max-h-72">
              {state.qr}
            </pre>
          ) : (
            <div className="flex flex-col items-center gap-3 text-ink-400">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">{zh ? '正在生成二维码…' : 'Generating QR code…'}</p>
            </div>
          )}

          {error && (
            <p className="mt-4 text-xs text-amber-300">
              {zh ? '实例可能仍在启动,正在重试…' : 'Instance may still be starting, retrying…'}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-white/10 flex justify-between items-center">
          <span className="text-xs text-ink-500">
            {zh ? '用手机 App 扫描上方二维码' : 'Scan the QR above with your phone app'}
          </span>
          <button
            onClick={() => { if (timer.current) clearTimeout(timer.current); poll(); }}
            className="text-ink-300 hover:text-white transition flex items-center gap-1 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd /Users/luopeng/vue/oneclaw_web && pnpm exec tsc --noEmit`
Expected: 无与本文件相关的报错

- [ ] **Step 3: 提交**

```bash
git add src/app/dashboard/_components/modals/QrBindModal.tsx
git commit -m "feat(dashboard): add QrBindModal for QR channel binding"
```

### Task 10:ChannelsModal 加「扫码绑定」入口

**Files:**
- Modify: `src/app/dashboard/_components/modals/ChannelsModal.tsx`

- [ ] **Step 1: import QrBindModal 与状态**

在文件顶部 import 区加:

```tsx
import QrBindModal from './QrBindModal';
```

在组件内已有的 useState 旁加:

```tsx
const [qrModal, setQrModal] = useState<{ channel: 'whatsapp' | 'wechat'; label: string } | null>(null);
```

- [ ] **Step 2: 在 qr 通道分支(已启用时)加按钮**

把 qr 分支里现有的 `<label>...</label>`(启用勾选框)包进一个容器,并在已启用时追加按钮。即把:

```tsx
                {def.kind === 'qr' ? (
                  <label className="flex items-start gap-3 cursor-pointer">
```

改为:

```tsx
                {def.kind === 'qr' ? (
                  <div className="space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer">
```

并在该 `</label>` 之后、qr 分支闭合 `)` 之前加:

```tsx
                    {isConfigured && (def.id === 'whatsapp' || def.id === 'wechat') && (
                      <button
                        type="button"
                        onClick={() => setQrModal({ channel: def.id as 'whatsapp' | 'wechat', label })}
                        className="text-xs bg-brand-500/15 hover:bg-brand-500/25 text-brand-200 border border-brand-500/30 rounded-lg px-3 py-1.5 transition"
                      >
                        {locale === 'zh' ? '扫码绑定' : 'Scan QR to bind'}
                      </button>
                    )}
                  </div>
```

> 注意:原 qr 分支结构是 `<label>…</label>`;改后变成 `<div className="space-y-3"><label>…</label>{按钮}</div>`,确保把原来紧跟 `</label>` 的 `) : (` 中的 `)` 对应到新 `</div>` 之后。

- [ ] **Step 3: 在组件 return 的最外层 `</div>` 之前挂载 modal**

在最外层包裹 div 关闭前加:

```tsx
      {qrModal && (
        <QrBindModal
          channel={qrModal.channel}
          label={qrModal.label}
          onClose={() => setQrModal(null)}
        />
      )}
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd /Users/luopeng/vue/oneclaw_web && pnpm exec tsc --noEmit && pnpm build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/app/dashboard/_components/modals/ChannelsModal.tsx
git commit -m "feat(dashboard): wire QR bind entry into ChannelsModal"
```

### Task 11:手动端到端验证

**Files:** 无

- [ ] **Step 1: 启用 whatsapp,部署,打开渠道配置 → 点「扫码绑定」**

确认 Modal 出现、二维码渲染(payload 路或 ASCII 回退路)。

- [ ] **Step 2: 用手机扫码,确认 Modal 切到「已连接 ✅」**

- [ ] **Step 3: 重新部署一次,确认无需重扫(凭证已持久化到 /data)**

依赖本仓库同期的 start.sh export 修复。若仍需重扫,回查 `OPENCLAW_STATE_DIR` 是否指向 /data。

---

## Self-Review

**Spec 覆盖:**
- gateway.js 捕获每通道状态 → Task 2/3 ✅
- `GET /repair/qr`(含 wechat 别名、disabled 判断)→ Task 4 ✅
- openclaw-repair.ts `repairGetChannelQr` → Task 7 ✅
- 独立 QrBindModal + ChannelsModal 入口 → Task 9/10 ✅
- 双路渲染(payload→canvas / ASCII 回退)→ Task 9 ✅
- qrcode 依赖 → Task 6 ✅
- 鉴权复用 Bearer secret / 服务端中转 → Task 4/8 ✅
- 错误处理(disabled/waiting/未就绪/刷新)→ Task 4/9 ✅
- 单测(解析纯函数)→ Task 2 ✅
- i18n(中英)→ 用 locale 内联,Task 9/10 ✅
- 日志格式未知 → Phase 0 验证 ✅
- 文档 → Task 5 ✅

**占位符扫描:** 无 TBD/TODO;`CHANNEL_PATTERNS` 给了可运行默认值,Phase 0 仅做确认/微调,非占位。

**类型一致性:** `ChannelQrState`(Task 7)字段 status/qr/raw/updatedAt 与端点返回(Task 4)、组件消费(Task 9)一致;渠道别名 `whatsapp|wechat` 在 Task 4/7/8/9/10 全程一致;内部 channel id `openclaw-weixin` 仅出现在 wrapper 侧(Task 2/4)。
