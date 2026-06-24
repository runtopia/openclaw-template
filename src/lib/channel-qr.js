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
    rawRe: /(?:weixin|wechat|微信).*\bqr\b\s*[:=]\s*(\S+)/i,
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
