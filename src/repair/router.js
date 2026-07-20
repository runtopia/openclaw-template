import express from "express";
import { mountAssistant } from "./assistant.js";
import { mountQrLogin } from "./qr-login.js";
import { mountConfigOps } from "./config-ops.js";
import { mountBrowserLogin } from "./browser-login.js";

export function createRepairRouter(deps) {
  const router = express.Router();
  mountCommandOps(router, deps);
  mountConfigOps(router, deps);
  mountQrLogin(router, deps);
  mountAssistant(router, deps);
  mountBrowserLogin(router, deps);
  return router;
}

function mountCommandOps(router, deps) {
  router.get("/personality", (_req, res) => {
    const employees = deps?.oneclawIntegration?.getCachedEmployees?.() || [];
    const main = employees.find((employee) => employee?.kind === "main") || employees[0] || null;
    res.json({
      ok: true,
      personality: main,
      employees,
    });
  });

  router.post("/commands/poll-now", async (_req, res) => {
    const pollCommands = deps?.oneclawIntegration?.pollCommands;
    if (typeof pollCommands !== "function") {
      return res.status(503).json({ ok: false, polled: false, error: "oneclaw command poller unavailable" });
    }
    const startedAt = Date.now();
    try {
      await pollCommands();
      res.json({ ok: true, polled: true, elapsed_ms: Date.now() - startedAt });
    } catch (err) {
      res.status(502).json({
        ok: false,
        polled: false,
        elapsed_ms: Date.now() - startedAt,
        error: String(err?.message || err),
      });
    }
  });
}
