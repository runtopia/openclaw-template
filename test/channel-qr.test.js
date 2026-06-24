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

test("tracker: 微信 payload 提取到 raw(非捕获组)", () => {
  const tr = createQrTracker();
  tr.ingest("[微信] qr: wx@PAYLOAD123");
  const s = tr.get("openclaw-weixin");
  assert.equal(s.status, "qr");
  assert.equal(s.raw, "wx@PAYLOAD123");
});
