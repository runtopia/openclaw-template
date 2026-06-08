// API routes: fix-webchat, test, personality sync.

import express from "express";

export function createApiRouter({
  OPENCLAW_NODE, clawArgs, runCmd, isConfigured, gatewayToken,
  instanceSecret, instanceId, trackMessage, fetchPersonality, applyPersonality,
  isGatewayReady, isGatewayStarting, gatewayTarget,
}) {
  const router = express.Router();

  router.post("/fix-webchat", async (req, res) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!gatewayToken || token !== gatewayToken) return res.status(401).json({ error: "Unauthorized" });
    if (!isConfigured()) return res.status(400).json({ error: "Instance not configured" });
    try {
      const authResult = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));
      const originsResult = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify([
        `http://localhost:${process.env.PORT || 8080}`,
        `http://127.0.0.1:${process.env.PORT || 8080}`,
        "https://oneclaw.net",
        "https://www.oneclaw.net",
      ])]));
      return res.json({ ok: true, results: { allowInsecureAuth: authResult.code === 0, allowedOrigins: originsResult.code === 0 } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post("/test", async (req, res) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!instanceSecret || token !== instanceSecret) return res.status(401).json({ error: "Unauthorized" });
    const { type, message } = req.body || {};
    if (type === "test") {
      console.log(`[test] received: ${message}`);
      trackMessage(0, null);
      let status = "unhealthy";
      if (gatewayTarget) {
        for (const endpoint of ["/health", "/openclaw", "/"]) {
          try {
            const r = await fetch(`${gatewayTarget}${endpoint}`, { signal: AbortSignal.timeout(2000) });
            if (r) { status = "healthy"; break; }
          } catch { /* continue */ }
        }
      } else {
        status = isGatewayReady() ? "healthy" : isGatewayStarting() ? "starting" : "unhealthy";
      }
      return res.json({ ok: true, message: "Test received", instanceId, status });
    }
    return res.json({ ok: true });
  });

  router.post("/personality/sync", async (req, res) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!instanceSecret || token !== instanceSecret) return res.status(401).json({ error: "Unauthorized" });
    try {
      const { personality, template } = await fetchPersonality();
      if (personality || template) {
        await applyPersonality(personality, template);
        return res.json({ ok: true, message: "Personality synced" });
      }
      return res.json({ ok: true, message: "No personality to sync" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}