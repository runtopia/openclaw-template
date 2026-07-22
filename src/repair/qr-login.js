import fs from "node:fs";
import path from "node:path";
import { startWechatLogin, getWechatLoginState, stopWechatLogin } from "../channels/wechat-login.js";

const WHATSAPP_DIAGNOSTIC_LOG_RE = /whatsapp|web\.login|provider|baileys|qr|auth|service restart|sigterm/i;

const SENSITIVE_KEYS = new Set(["apiKey", "token", "secret", "password", "key"]);

function redactConfig(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redactConfig);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEYS.has(k) ||
      k.toLowerCase().includes("token") ||
      k.toLowerCase().includes("secret") ||
      k.toLowerCase().includes("apikey");
    out[k] = (isSensitive && typeof v === "string" && v) ? "[REDACTED]" : redactConfig(v);
  }
  return out;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function credentialFileHasIdentity(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return !!(
      parsed?.me?.id ||
      parsed?.creds?.me?.id ||
      parsed?.registrationId ||
      parsed?.noiseKey ||
      parsed?.signedIdentityKey
    );
  } catch {
    return false;
  }
}

function collectWhatsAppCredentialFiles(rootDir, rootLabel) {
  const matches = [];
  const stack = [rootDir];
  const maxVisited = 300;
  let visited = 0;

  while (stack.length > 0 && visited < maxVisited) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const lower = full.toLowerCase();
      if (entry.isDirectory()) {
        if (lower.includes("whatsapp") || lower.includes("baileys") || lower.includes("wa")) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!lower.includes("whatsapp") && !lower.includes("baileys") && !lower.endsWith("creds.json")) continue;
      if (!lower.endsWith(".json")) continue;

      if (credentialFileHasIdentity(full)) {
        matches.push(toPosixPath(path.join(rootLabel, path.relative(rootDir, full))));
      }
    }
  }

  return matches.sort();
}

function inspectWhatsAppLoginState(stateDir) {
  const legacyCredentialsDir = path.join(stateDir, "credentials");
  const oauthWhatsAppDir = path.join(stateDir, "oauth", "whatsapp");
  const credentialFiles = [
    ...collectWhatsAppCredentialFiles(legacyCredentialsDir, "credentials"),
    ...collectWhatsAppCredentialFiles(oauthWhatsAppDir, path.join("oauth", "whatsapp")),
  ].sort();
  const accountDirs = [];

  try {
    const entries = fs.readdirSync(oauthWhatsAppDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const prefix = toPosixPath(path.join("oauth", "whatsapp", entry.name)) + "/";
      accountDirs.push({
        accountId: entry.name,
        hasCredentials: credentialFiles.some((file) => file.startsWith(prefix)),
      });
    }
  } catch {
    // No OAuth WhatsApp state yet.
  }

  return {
    connected: credentialFiles.length > 0,
    credentialFiles,
    accountDirs: accountDirs.sort((a, b) => a.accountId.localeCompare(b.accountId)),
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPackageVersion(packageDir) {
  const pkg = readJsonIfExists(path.join(packageDir, "package.json"));
  return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
}

function buildWhatsAppLoginDiagnostics({ stateDir, configFilePath, gatewayManager, gatewayRpc }) {
  const cfgPath = configFilePath();
  const cfg = readJsonIfExists(cfgPath) || {};
  const whatsappConfig = cfg?.channels?.whatsapp || null;
  const pluginEntry = cfg?.plugins?.entries?.whatsapp || null;
  const pluginInstall = cfg?.plugins?.installs?.whatsapp || null;
  const installPath = typeof pluginInstall?.installPath === "string" && pluginInstall.installPath.trim()
    ? pluginInstall.installPath.trim()
    : null;
  const auth = inspectWhatsAppLoginState(stateDir);
  const bindings = Array.isArray(cfg?.bindings)
    ? cfg.bindings
      .filter((binding) => binding?.match?.channel === "whatsapp")
      .map((binding) => ({
        agentId: binding.agentId ?? null,
        accountId: binding.match?.accountId ?? null,
      }))
    : [];
  const logs = (gatewayManager?.getRecentLogs?.(500) || [])
    .filter((line) => WHATSAPP_DIAGNOSTIC_LOG_RE.test(String(line)))
    .slice(-80);

  return {
    gateway: {
      ready: !!gatewayManager?.isGatewayReady?.(),
      starting: !!gatewayManager?.isGatewayStarting?.(),
      rpc: typeof gatewayRpc?.getConnectionState === "function" ? gatewayRpc.getConnectionState() : null,
    },
    plugin: {
      entry: redactConfig(pluginEntry),
      install: redactConfig(pluginInstall),
      installPath,
      installPathExists: installPath ? fs.existsSync(installPath) : false,
      packageVersion: installPath ? readPackageVersion(installPath) : null,
    },
    channel: redactConfig(whatsappConfig),
    accounts: {
      configuredAccountIds: Object.keys(whatsappConfig?.accounts || {}).sort(),
      bindings,
      auth,
    },
    logs,
  };
}

export function mountQrLogin(router, deps) {
  const {
    requireSetupAuth,
    instanceSecret,
    OPENCLAW_NODE,
    clawArgs,
    stateDir,
    configFilePath,
    gatewayManager,
    gatewayTarget,
    gatewayToken,
    gatewayRpc,
  } = deps;

  // 双重认证：SETUP_PASSWORD (Basic Auth) 或 ONECLAW_INSTANCE_SECRET (Bearer)
  function requireRepairAuth(req, res, next) {
    if (instanceSecret) {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/, "");
      if (bearer === instanceSecret) return next();
    }
    return requireSetupAuth(req, res, next);
  }

  // ── WhatsApp QR login ───────────────────────────────────────
  // WhatsApp's QR is NOT printed to gateway stdout; it's returned by the
  // gateway WS RPC `web.login.start` as a PNG data URL. We forward the RPC
  // over the wrapper's persistent gateway WS (gatewayRpc.rpcGateway) so the
  // dashboard can fetch it via plain HTTP.
  //   POST /whatsapp-login/start → { qrDataUrl, connected, message }
  //   POST /whatsapp-login/wait  → { qrDataUrl, connected, message }  (pass currentQrDataUrl in body)
  const WHATSAPP_GATEWAY_RPC_WAIT_MS = 10_000;
  const WHATSAPP_GATEWAY_WARMUP_GRACE_MS = 1_500;
  const WHATSAPP_LOGIN_OPERATION_TIMEOUT_MS = 10_000;

  function sendWhatsAppLoginPreparing(res, message = "WhatsApp gateway is starting. Retrying shortly.") {
    return res.status(202).json({
      ok: true,
      status: "starting",
      preparing: true,
      qrDataUrl: null,
      connected: false,
      message,
    });
  }

  function startGatewayInBackground() {
    gatewayManager?.ensureGatewayRunning?.()
      .then(() => gatewayRpc?.start?.())
      .catch((err) => console.error(`[whatsapp-login] gateway warmup failed: ${err?.message || err}`));
  }

  async function waitForGatewayWarmup(timeoutMs) {
    const warmup = gatewayManager?.ensureGatewayRunning?.()
      .then(() => true)
      .catch((err) => {
        console.error(`[whatsapp-login] gateway warmup failed: ${err?.message || err}`);
        return false;
      });
    if (!warmup) return false;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
    const ready = await Promise.race([warmup, timeout]);
    if (ready) gatewayRpc?.start?.();
    return ready;
  }

  async function whatsappLoginRpc(res, method, params) {
    if (!gatewayRpc) return res.status(503).json({ ok: false, error: "gateway rpc unavailable" });
    try {
      if (gatewayManager && !gatewayManager.isGatewayReady?.()) {
        const warmed = await waitForGatewayWarmup(WHATSAPP_GATEWAY_WARMUP_GRACE_MS);
        if (!warmed && !gatewayManager.isGatewayReady?.()) {
          startGatewayInBackground();
          return sendWhatsAppLoginPreparing(res);
        }
      }
      gatewayRpc.start?.();
      if (typeof gatewayRpc.waitUntilConnected === "function") {
        try {
          await gatewayRpc.waitUntilConnected(WHATSAPP_GATEWAY_RPC_WAIT_MS);
        } catch {
          startGatewayInBackground();
          return sendWhatsAppLoginPreparing(res);
        }
      }
      const frame = await gatewayRpc.rpcGateway(method, params);
      // frame: { ok, payload: { qrDataUrl?, connected?, message? } }
      const p = frame.payload || {};
      res.json({ ok: !!frame.ok, qrDataUrl: p.qrDataUrl ?? null, connected: !!p.connected, message: p.message ?? null, error: frame.ok ? null : (frame.error?.message ?? "rpc failed") });
    } catch (err) {
      res.status(502).json({ ok: false, error: String(err?.message || err) });
    }
  }

  router.post("/whatsapp-login/start", requireRepairAuth, async (req, res) => {
    const force = req.body?.force === true;
    const accountId = typeof req.body?.accountId === "string" && req.body.accountId.trim()
      ? req.body.accountId.trim() : undefined;
    // accountId = employee id → per-agent whatsapp account (multi-account).
    await whatsappLoginRpc(res, "web.login.start", { force, timeoutMs: WHATSAPP_LOGIN_OPERATION_TIMEOUT_MS, ...(accountId ? { accountId } : {}) });
  });

  router.post("/whatsapp-login/wait", requireRepairAuth, async (req, res) => {
    const currentQrDataUrl = typeof req.body?.currentQrDataUrl === "string" ? req.body.currentQrDataUrl : undefined;
    // accountId 必须与 start 一致：登录会话按 accountId 隔离，不传会退回
    // DEFAULT_ACCOUNT_ID → 查不到 start(accountId) 建的会话 → "No active login"。
    const accountId = typeof req.body?.accountId === "string" && req.body.accountId.trim()
      ? req.body.accountId.trim() : undefined;
    await whatsappLoginRpc(res, "web.login.wait", { timeoutMs: WHATSAPP_LOGIN_OPERATION_TIMEOUT_MS, ...(currentQrDataUrl ? { currentQrDataUrl } : {}), ...(accountId ? { accountId } : {}) });
  });

  router.get("/whatsapp-login/status", requireRepairAuth, (_req, res) => {
    try {
      res.json({ ok: true, ...inspectWhatsAppLoginState(stateDir) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/whatsapp-login/diagnostics", requireRepairAuth, (_req, res) => {
    try {
      res.json({ ok: true, ...buildWhatsAppLoginDiagnostics({ stateDir, configFilePath, gatewayManager, gatewayRpc }) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── WeChat QR login ──────────────────────────────────────────
  // 新版 @tencent-weixin/openclaw-weixin 已注册 gateway HTTP 路由，优先走
  // /plugins/openclaw-weixin/qr-start，避免每次 spawn CLI 冷启动和 stdout 解析。
  // 老插件或路由不可用时再回退到 `openclaw channels login --channel openclaw-weixin`。
  const WECHAT_PLUGIN_QR_START_ATTEMPTS = 2;
  const WECHAT_PLUGIN_RETRY_DELAY_MS = 350;
  const WECHAT_PLUGIN_STARTUP_WAIT_MS = deps.wechatPluginStartupWaitMs ?? 12_000;
  const WECHAT_PLUGIN_STARTUP_POLL_MS = deps.wechatPluginStartupPollMs ?? 500;
  let wechatPluginSession = null;
  let wechatPluginHttpUnavailable = false;

  function wechatPluginBaseUrl() {
    return (gatewayTarget || gatewayManager?.GATEWAY_TARGET || "").replace(/\/+$/, "");
  }

  function canUseWechatPluginHttp() {
    return !wechatPluginHttpUnavailable && !!(wechatPluginBaseUrl() && gatewayToken);
  }

  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchWechatPluginJson(pathname, opts = {}) {
    const base = wechatPluginBaseUrl();
    if (!base) throw new Error("wechat plugin gateway target unavailable");
    const attempts = opts.attempts ?? 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const res = await fetch(`${base}/plugins/openclaw-weixin${pathname}`, {
          method: opts.method || "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${gatewayToken}`,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
        });
        const raw = await res.text();
        const elapsed = Date.now() - startedAt;
        console.log(`[wechat-login] plugin ${opts.method || "GET"} ${pathname} attempt=${attempt} status=${res.status} elapsed=${elapsed}ms`);
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = { message: raw };
        }
        if (!res.ok) {
          const err = new Error(data.error || data.message || `wechat plugin ${pathname} failed: ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return data;
      } catch (err) {
        lastErr = err;
        const transient = err?.status == null || err.status >= 500;
        if (attempt < attempts && transient) {
          console.warn(`[wechat-login] plugin ${pathname} attempt=${attempt} failed, retrying: ${err.message}`);
          await sleep(WECHAT_PLUGIN_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error(`wechat plugin ${pathname} failed`);
  }

  function wechatPluginQrExpiresAt(data) {
    const raw = data?.qrExpiresAt ?? data?.qr_expires_at ?? data?.expiresAt ?? data?.expires_at ?? null;
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return raw.trim();
  }

  function sameWechatPluginSession(accountId) {
    if (!wechatPluginSession?.sessionKey || !wechatPluginSession.qrUrl) return false;
    return (wechatPluginSession.accountId || null) === (accountId || null);
  }

  function wechatPluginSessionQrExpired() {
    const raw = wechatPluginSession?.qrExpiresAt;
    if (!raw) return false;
    const expiresAt = Date.parse(raw);
    if (!Number.isFinite(expiresAt)) return false;
    return Date.now() >= expiresAt;
  }

  function cachedWechatPluginLoginState(message = null) {
    return {
      ok: true,
      status: "scan",
      connected: false,
      qrUrl: wechatPluginSession.qrUrl,
      qrDataUrl: wechatPluginSession.qrUrl,
      qrExpiresAt: wechatPluginSession.qrExpiresAt || null,
      qrUpdatedAt: wechatPluginSession.qrUpdatedAt || null,
      sessionKey: wechatPluginSession.sessionKey,
      message: message || wechatPluginSession.message || null,
    };
  }

  async function startWechatPluginLogin(accountId, force, expiresAt) {
    if (!force && sameWechatPluginSession(accountId) && !wechatPluginSessionQrExpired()) {
      try {
        return await getWechatPluginLoginState();
      } catch (err) {
        return cachedWechatPluginLoginState(err.message);
      }
    }
    if (gatewayManager && !gatewayManager.isGatewayReady?.()) {
      const warmed = await waitForGatewayWarmup(WHATSAPP_GATEWAY_WARMUP_GRACE_MS);
      if (!warmed && !gatewayManager.isGatewayReady?.()) {
        startGatewayInBackground();
        return { preparing: true };
      }
    }
    const body = {
      ...(accountId ? { accountId } : {}),
      ...(force ? { force: true } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    const startupDeadline = Date.now() + WECHAT_PLUGIN_STARTUP_WAIT_MS;
    let data;
    while (true) {
      try {
        data = await fetchWechatPluginJson("/qr-start", {
          method: "POST",
          body,
          attempts: WECHAT_PLUGIN_QR_START_ATTEMPTS,
        });
        break;
      } catch (err) {
        if (err?.status !== 404 || Date.now() >= startupDeadline) throw err;
        console.log("[wechat-login] plugin QR route is not registered yet; waiting for gateway startup");
        await sleep(Math.min(WECHAT_PLUGIN_STARTUP_POLL_MS, Math.max(1, startupDeadline - Date.now())));
      }
    }
    const qrUrl = data.qrDataUrl || data.qrUrl || null;
    if (!qrUrl) throw new Error(data.error || data.message || "wechat plugin did not return qrDataUrl");
    const qrExpiresAt = wechatPluginQrExpiresAt(data);
    wechatPluginSession = {
      sessionKey: data.sessionKey || accountId || "",
      accountId: accountId || null,
      qrUrl,
      qrExpiresAt,
      qrUpdatedAt: data.qrUpdatedAt || data.qr_updated_at || null,
      message: data.message || null,
      updatedAt: Date.now(),
    };
    return {
      ok: true,
      status: "scan",
      connected: false,
      qrUrl,
      qrDataUrl: qrUrl,
      qrExpiresAt,
      qrUpdatedAt: wechatPluginSession.qrUpdatedAt,
      sessionKey: wechatPluginSession.sessionKey,
      message: data.message || null,
    };
  }

  async function getWechatPluginLoginState() {
    if (!wechatPluginSession?.sessionKey) return null;
    const query = `?sessionKey=${encodeURIComponent(wechatPluginSession.sessionKey)}`;
    const data = await fetchWechatPluginJson(`/qr-status${query}`, { method: "GET", attempts: 1 });
    const refreshedQrUrl = data.qrDataUrl || data.qrUrl || null;
    if (refreshedQrUrl) wechatPluginSession.qrUrl = refreshedQrUrl;
    const qrExpiresAt = wechatPluginQrExpiresAt(data) || wechatPluginSession.qrExpiresAt || null;
    wechatPluginSession.qrExpiresAt = qrExpiresAt;
    wechatPluginSession.qrUpdatedAt = data.qrUpdatedAt || data.qr_updated_at || wechatPluginSession.qrUpdatedAt || null;
    if (data.status === "connected") {
      return {
        ok: true,
        status: "connected",
        connected: true,
        connectedAccountId: data.accountId || null,
        accountId: data.accountId || null,
        qrUrl: wechatPluginSession.qrUrl,
        qrDataUrl: wechatPluginSession.qrUrl,
        qrExpiresAt,
        qrUpdatedAt: wechatPluginSession.qrUpdatedAt,
        sessionKey: wechatPluginSession.sessionKey,
        message: data.message || "已将此 OpenClaw 连接到微信。",
      };
    }
    if (data.status === "failed") {
      return {
        ok: true,
        status: "error",
        connected: false,
        qrUrl: wechatPluginSession.qrUrl,
        qrDataUrl: wechatPluginSession.qrUrl,
        qrExpiresAt,
        qrUpdatedAt: wechatPluginSession.qrUpdatedAt,
        sessionKey: wechatPluginSession.sessionKey,
        message: data.error || data.message || "微信扫码登录失败",
      };
    }
    return {
      ok: true,
      status: "scan",
      connected: false,
      qrUrl: wechatPluginSession.qrUrl,
      qrDataUrl: wechatPluginSession.qrUrl,
      qrExpiresAt,
      qrUpdatedAt: wechatPluginSession.qrUpdatedAt,
      sessionKey: wechatPluginSession.sessionKey,
      message: data.message || wechatPluginSession.message,
    };
  }

  router.post("/wechat-login/start", requireRepairAuth, async (req, res) => {
    const accountId = typeof req.body?.accountId === "string" && req.body.accountId.trim()
      ? req.body.accountId.trim() : undefined;
    const expiresAt = typeof req.body?.expiresAt === "string" && req.body.expiresAt.trim()
      ? req.body.expiresAt.trim() : undefined;
    if (canUseWechatPluginHttp()) {
      try {
        const started = await startWechatPluginLogin(accountId, req.body?.force === true, expiresAt);
        if (started.preparing) {
          return res.status(202).json({ ok: true, status: "starting", qrUrl: null, qrDataUrl: null, connected: false, message: "WeChat gateway is starting. Retrying shortly." });
        }
        return res.json(started);
      } catch (err) {
        if (err?.status === 404) {
          wechatPluginHttpUnavailable = true;
          console.warn("[wechat-login] plugin HTTP QR route unavailable (404); using CLI fallback for this process");
        } else {
          console.warn(`[wechat-login] plugin HTTP QR start failed, falling back to CLI: ${err.message}`);
        }
      }
    }
    const s = startWechatLogin({ OPENCLAW_NODE, clawArgs, accountId });
    res.json({ ok: true, ...s });
  });

  router.get("/wechat-login", requireRepairAuth, async (_req, res) => {
    if (canUseWechatPluginHttp() && wechatPluginSession?.sessionKey) {
      try {
        return res.json(await getWechatPluginLoginState());
      } catch (err) {
        console.warn(`[wechat-login] plugin HTTP QR status failed, using last state: ${err.message}`);
        return res.json({
          ok: true,
          status: "scan",
          connected: false,
          qrUrl: wechatPluginSession.qrUrl,
          qrDataUrl: wechatPluginSession.qrUrl,
          qrExpiresAt: wechatPluginSession.qrExpiresAt || null,
          qrUpdatedAt: wechatPluginSession.qrUpdatedAt || null,
          sessionKey: wechatPluginSession.sessionKey,
          message: err.message,
        });
      }
    }
    res.json({ ok: true, ...getWechatLoginState() });
  });

  router.post("/wechat-login/stop", requireRepairAuth, async (_req, res) => {
    const sessionKey = wechatPluginSession?.sessionKey;
    if (canUseWechatPluginHttp() && sessionKey) {
      try {
        await fetchWechatPluginJson("/qr-stop", {
          method: "POST",
          body: { sessionKey },
          attempts: 1,
        });
      } catch (err) {
        console.warn(`[wechat-login] plugin HTTP QR stop failed: ${err.message}`);
      }
    }
    wechatPluginSession = null;
    stopWechatLogin();
    res.json({ ok: true, ...getWechatLoginState() });
  });
}
