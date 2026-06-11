import express from "express";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFile = promisify(_execFile);

const EXEC_TIMEOUT = 180000; // 180s

/**
 * Run `openclaw skills list --agent <agentId> --json` and parse the baseDir
 * for the given slug. Returns null if parsing fails.
 */
async function resolveSkillDir(agentId, slug) {
  try {
    const { stdout } = await execFile(
      "openclaw",
      ["skills", "list", "--agent", agentId, "--json"],
      { timeout: EXEC_TIMEOUT },
    );
    const data = JSON.parse(stdout);
    // Expected shape: { baseDir?: string } or array of { slug, dir }
    if (data && typeof data.baseDir === "string") {
      return `${data.baseDir}/${slug}`;
    }
    if (Array.isArray(data)) {
      const entry = data.find((s) => s.slug === slug);
      if (entry?.dir) return entry.dir;
      if (entry?.baseDir) return `${entry.baseDir}/${slug}`;
      // If any entry has a baseDir property, use it
      const anyBaseDir = data.find((s) => s.baseDir)?.baseDir;
      if (anyBaseDir) return `${anyBaseDir}/${slug}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function createSkillsRouter() {
  const router = express.Router();

  // POST /skills/install
  // body: { agentId, slug, version?, force? }
  router.post("/install", async (req, res) => {
    const { agentId, slug, version, force } = req.body || {};
    if (!agentId || !slug) {
      return res.status(400).json({ ok: false, error: "agentId and slug are required" });
    }

    const args = ["skills", "install", slug, "--agent", agentId];
    if (version) args.push("--version", version);
    if (force) args.push("--force");

    try {
      const { stdout, stderr } = await execFile("openclaw", args, { timeout: EXEC_TIMEOUT });
      return res.json({ ok: true, stdout: stdout || "", stderr: stderr || "", code: 0 });
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || String(err);
      const code = typeof err.code === "number" ? err.code : 1;
      return res.json({ ok: false, stdout, stderr, code });
    }
  });

  // POST /skills/update
  // body: { agentId, slug }
  router.post("/update", async (req, res) => {
    const { agentId, slug } = req.body || {};
    if (!agentId || !slug) {
      return res.status(400).json({ ok: false, error: "agentId and slug are required" });
    }

    const args = ["skills", "update", slug, "--agent", agentId];

    try {
      const { stdout, stderr } = await execFile("openclaw", args, { timeout: EXEC_TIMEOUT });
      return res.json({ ok: true, stdout: stdout || "", stderr: stderr || "", code: 0 });
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || String(err);
      const code = typeof err.code === "number" ? err.code : 1;
      return res.json({ ok: false, stdout, stderr, code });
    }
  });

  // DELETE /skills/:slug?agentId=
  router.delete("/:slug", async (req, res) => {
    const { slug } = req.params;
    const agentId = req.query.agentId;
    if (!agentId || !slug) {
      return res.status(400).json({ ok: false, error: "agentId query param and slug path param are required" });
    }

    // Try to resolve the skill directory via CLI; fall back to convention path
    let skillDir = await resolveSkillDir(agentId, slug);
    if (!skillDir) {
      skillDir = `/data/agents/${agentId}/skills/${slug}`;
    }

    try {
      await fs.rm(skillDir, { recursive: true, force: true });
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ ok: false, error: String(err) });
    }
  });

  return router;
}
