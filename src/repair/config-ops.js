import fs from "node:fs";
import { readChannelBindings, applyChannelBinding, removeChannelBinding } from "../channels/bindings.js";
import { patchConfig, setIn } from "../config/edit.js";
import { applyChannelPolicy, normalizeChannelAccessPolicy } from "../channels/access-policy.js";

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

export function mountConfigOps(router, deps) {
  const {
    requireSetupAuth,
    instanceSecret,
    runCmd,
    clawArgs,
    OPENCLAW_NODE,
    restartGateway,
    configFilePath,
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

  // GET / — 可用端点列表（无需认证，方便快速确认服务存活）
  router.get("/", (_req, res) => {
    res.json({
      ok: true,
      endpoints: ["GET /status", "GET /logs", "GET /config", "POST /chat", "POST /restart", "POST /doctor", "PATCH /config", "POST /whatsapp-login/start", "POST /whatsapp-login/wait", "GET /whatsapp-login/status", "GET /whatsapp-login/diagnostics", "POST /wechat-login/start", "GET /wechat-login", "GET /channel-status", "GET /channel-bindings", "POST /bind-channel", "POST /unbind-channel", "PATCH /channel-policy", "GET /channel-access-requests", "POST /channel-access-requests/:requestId/approve", "POST /channel-access-requests/:requestId/reject"],
    });
  });

  // POST /doctor
  router.post("/doctor", requireRepairAuth, async (_req, res) => {
    try {
      const result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--yes"]));
      res.json({ ok: result.code === 0, output: result.output });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /restart
  router.post("/restart", requireRepairAuth, async (_req, res) => {
    try {
      const result = await restartGateway({ waitReady: false });
      if (!result?.coalesced) gatewayRpc?.restart();
      res.json({ ok: true, pending: true, coalesced: !!result?.coalesced });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // PATCH /config
  router.patch("/config", requireRepairAuth, (req, res) => {
    const { patches } = req.body || {};
    if (!patches || typeof patches !== "object" || Array.isArray(patches)) {
      return res.status(400).json({ ok: false, error: "patches must be an object" });
    }
    try {
      patchConfig(configFilePath(), (cfg) => {
        for (const [dotPath, value] of Object.entries(patches)) {
          setIn(cfg, dotPath, value);
        }
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /config (redacted)
  router.get("/config", requireRepairAuth, (req, res) => {
    try {
      const cfgPath = configFilePath();
      if (!fs.existsSync(cfgPath)) return res.json({ ok: true, config: null });
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      res.json({ ok: true, config: redactConfig(raw) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /channel-status — 返回各 qr 通道的 per-agent 绑定(读 openclaw.json bindings)。
  // bindings: [{agentId, match:{channel, accountId}}]。扫码绑定时 accountId=empId,
  // agentId=该员工的 openclawAgentId。前端按当前员工 openclawAgentId 判断是否已绑。
  // (之前用凭证文件判断 instance 级 bool,无法区分绑到哪个 agent。)
  router.get("/channel-status", requireRepairAuth, (_req, res) => {
    try {
      let bindings = [];
      try {
        const cfgPath = configFilePath();
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
        }
      } catch { /* config unreadable → no bindings */ }
      const pick = (ch) => bindings
        .filter((b) => b?.match?.channel === ch)
        .map((b) => ({ agentId: b.agentId ?? null, accountId: b.match?.accountId ?? null }));
      res.json({
        ok: true,
        whatsapp: pick("whatsapp"),
        wechat: pick("openclaw-weixin"),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/channel-bindings", requireRepairAuth, (_req, res) => {
    try {
      const cfgPath = configFilePath();
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
      res.json(readChannelBindings(cfg));
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.patch("/channel-policy", requireRepairAuth, (req, res) => {
    const { channel, accountId, access } = req.body || {};
    try {
      let written;
      patchConfig(configFilePath(), (cfg) => {
        written = applyChannelPolicy(cfg, {
          channel,
          accountId,
          access: normalizeChannelAccessPolicy(access),
        });
      });
      res.json({ ok: true, channel, accountId: accountId ?? null, policy: written });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/channel-access-requests", requireRepairAuth, async (req, res) => {
    const channel = typeof req.query.channel === "string" && req.query.channel.trim()
      ? req.query.channel.trim()
      : undefined;
    try {
      const args = ["pairing", "list"];
      if (channel) args.push(channel);
      const r = await runCmd(OPENCLAW_NODE, clawArgs(args));
      res.status(r.code === 0 ? 200 : 500).json({
        ok: r.code === 0,
        channel: channel ?? null,
        requests: [],
        output: r.output,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/channel-access-requests/:requestId/approve", requireRepairAuth, async (req, res) => {
    const { channel, code } = req.body || {};
    const pairingCode = typeof code === "string" && code.trim()
      ? code.trim()
      : String(req.params.requestId || "").trim();
    if (!channel || !pairingCode) {
      return res.status(400).json({ ok: false, error: "Missing channel or pairing code" });
    }
    try {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), pairingCode]));
      res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/channel-access-requests/:requestId/reject", requireRepairAuth, async (req, res) => {
    const { channel } = req.body || {};
    const pairingCode = String(req.params.requestId || "").trim();
    if (!channel || !pairingCode) {
      return res.status(400).json({ ok: false, error: "Missing channel or pairing code" });
    }
    res.json({
      ok: true,
      rejected: true,
      channel,
      code: pairingCode,
      note: "OpenClaw CLI does not currently expose a pairing reject command; request was left unapproved.",
    });
  });

  // POST /bind-channel — 扫码成功后把 channel account 绑到 agent(per-employee)。
  //   body: {channel, accountId(=empId), agentId(=openclawAgentId)}
  // patches openclaw.json:
  //   bindings += {agentId, match:{channel, accountId}}(幂等:同 channel+accountId 替换)
  //   channels.<channel>.accounts.<accountId> = {enabled:true}
  router.post("/bind-channel", requireRepairAuth, (req, res) => {
    const { channel, accountId, agentId } = req.body || {};
    try {
      let written;
      patchConfig(configFilePath(), (cfg) => {
        written = applyChannelBinding(cfg, { channel, accountId, agentId });
      });
      res.json({ ok: true, binding: written });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/unbind-channel", requireRepairAuth, (req, res) => {
    const { channel, accountId, agentId } = req.body || {};
    try {
      let result;
      patchConfig(configFilePath(), (cfg) => {
        result = removeChannelBinding(cfg, { channel, accountId, agentId });
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });
}
