import fs from "node:fs";
import path from "node:path";
import { startWechatLogin, getWechatLoginState } from "../channels/wechat-login.js";

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

  function sendWhatsAppLoginPreparing(res, message = "WhatsApp gateway is starting. Retrying shortly.") {
    return res.status(202).json({ ok: true, qrDataUrl: null, connected: false, message });
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
    await whatsappLoginRpc(res, "web.login.start", { force, timeoutMs: 30_000, ...(accountId ? { accountId } : {}) });
  });

  router.post("/whatsapp-login/wait", requireRepairAuth, async (req, res) => {
    const currentQrDataUrl = typeof req.body?.currentQrDataUrl === "string" ? req.body.currentQrDataUrl : undefined;
    await whatsappLoginRpc(res, "web.login.wait", { timeoutMs: 30_000, ...(currentQrDataUrl ? { currentQrDataUrl } : {}) });
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
  // WeChat has no web RPC; its QR only appears when running
  // `openclaw channels login --channel openclaw-weixin` (printed to stdout as
  // a URL). We spawn that process and parse its stdout for the qrUrl.
  router.post("/wechat-login/start", requireRepairAuth, (req, res) => {
    const accountId = typeof req.body?.accountId === "string" && req.body.accountId.trim()
      ? req.body.accountId.trim() : undefined;
    const s = startWechatLogin({ OPENCLAW_NODE, clawArgs, accountId });
    res.json({ ok: true, ...s });
  });

  router.get("/wechat-login", requireRepairAuth, (_req, res) => {
    res.json({ ok: true, ...getWechatLoginState() });
  });
}
