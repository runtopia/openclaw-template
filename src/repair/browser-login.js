export function mountBrowserLogin(router, deps) {
  const { requireSetupAuth, instanceSecret, issueBrowserLoginUrl } = deps;

  function requireRepairAuth(req, res, next) {
    if (instanceSecret) {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/, "");
      if (bearer === instanceSecret) return next();
    }
    return requireSetupAuth(req, res, next);
  }

  router.post("/openclaw-login", requireRepairAuth, (req, res) => {
    if (typeof issueBrowserLoginUrl !== "function") {
      return res.status(503).json({ ok: false, error: "browser login unavailable" });
    }
    const next = typeof req.body?.next === "string" ? req.body.next : "/openclaw/";
    const ticket = issueBrowserLoginUrl(req, next);
    return res.json({ ok: true, url: ticket.url, expiresAt: new Date(ticket.expiresAt).toISOString() });
  });
}
