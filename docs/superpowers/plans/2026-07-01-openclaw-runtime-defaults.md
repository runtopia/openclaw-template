# OpenClaw Runtime Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `openclaw-template` generated and persisted configs use two-hour heartbeat defaults, ClawRouters-backed memory search, and OpenClaw `2026.6.11`.

**Architecture:** Centralize runtime defaults in `src/lib/direct-config.js`, then call that shared helper from every startup path that writes or patches `openclaw.json`. Keep secrets as OpenClaw SecretRef objects and let OpenClaw append `/embeddings` to the `/api/v1` base URL.

**Tech Stack:** Node.js ESM, built-in `node:test`, OpenClaw config JSON, Dockerfile npm package versions.

---

### Task 1: Add Tests for Runtime Defaults

**Files:**
- Modify: `test/clawrouters-base-url.test.js`

- [ ] **Step 1: Write failing tests**

Add assertions that fresh config generation and existing config patching produce:

```js
assert.deepEqual(cfg.agents.defaults.heartbeat, { every: "2h", target: "last" });
assert.equal(cfg.agents.defaults.memorySearch.enabled, true);
assert.deepEqual(cfg.agents.defaults.memorySearch.sources, ["memory", "sessions"]);
assert.equal(cfg.agents.defaults.memorySearch.provider, "clawrouters");
assert.equal(cfg.agents.defaults.memorySearch.model, "auto");
assert.equal(cfg.agents.defaults.memorySearch.remote.baseUrl, "https://clawrouters-dev.example.com/api/v1");
assert.deepEqual(cfg.agents.defaults.memorySearch.remote.apiKey, {
  source: "env",
  provider: "default",
  id: "CLAWROUTERS_API_KEY",
});
```

- [ ] **Step 2: Run test to verify red**

Run: `node --test test/clawrouters-base-url.test.js`

Expected: fail because `memorySearch` or the patch helper does not exist yet.

### Task 2: Implement Shared Defaults

**Files:**
- Modify: `src/lib/direct-config.js`
- Modify: `src/lib/auto-config.js`
- Modify: `src/init-config.js`
- Modify: `src/sidecar.js`
- Modify: `src/server.js`

- [ ] **Step 1: Add helpers in `direct-config.js`**

Create `buildClawroutersMemorySearch(env)`, `applyRuntimeDefaults(cfg, env)`, and replace `patchClawroutersProviderBaseUrl` with a compatibility wrapper that calls the broader helper.

- [ ] **Step 2: Use helpers in fresh config generation**

Build `agentDefaults` with heartbeat and ClawRouters memory search when ClawRouters credentials exist.

- [ ] **Step 3: Use helpers in existing config patch paths**

Call `applyRuntimeDefaults(cfg, process.env)` from `init-config.js`, `sidecar.js`, `server.js`, and `auto-config.js`.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/clawrouters-base-url.test.js`

Expected: all tests in that file pass.

### Task 3: Upgrade OpenClaw Versions

**Files:**
- Modify: `Dockerfile`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update official OpenClaw packages**

Set `ARG OPENCLAW_VERSION=2026.6.11` and update official `@openclaw/*` plugin package specs to `2026.6.11`.

- [ ] **Step 2: Update docs**

Update internal notes that mention the previously verified OpenClaw version to `2026.6.11`.

### Task 4: Verify and Commit

**Files:**
- All changed files

- [ ] **Step 1: Run focused tests**

Run: `node --test test/clawrouters-base-url.test.js`

Expected: pass.

- [ ] **Step 2: Run broader test suite**

Run: `npm test`

Expected: pass if the repository defines a working test script; otherwise report the actual npm error.

- [ ] **Step 3: Inspect diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only intended files changed.

- [ ] **Step 4: Commit and push**

Run:

```bash
git add Dockerfile CLAUDE.md src/lib/direct-config.js src/lib/auto-config.js src/init-config.js src/sidecar.js src/server.js test/clawrouters-base-url.test.js docs/superpowers/specs/2026-07-01-openclaw-runtime-defaults-design.md docs/superpowers/plans/2026-07-01-openclaw-runtime-defaults.md
git commit -m "feat: enable clawrouters memory search defaults"
git push
```
