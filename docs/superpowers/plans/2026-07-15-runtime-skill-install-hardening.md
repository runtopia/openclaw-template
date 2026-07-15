# Runtime Skill Install Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden custom and builtin runtime skill installation.

**Architecture:** Stage custom archives in a private workspace directory instead of system `/tmp`. Validate any readiness metadata returned by `skills.status` while retaining compatibility with name-only legacy entries.

**Tech Stack:** Node.js, `node:test`, OpenClaw gateway RPC and CLI.

---

### Task 1: Add regression coverage

**Files:**
- Test: `test/oneclaw-go-api.test.js`

- [x] Add a custom-skill assertion that the install source is under `<workspace>/.tmp` and is removed after the command.
- [x] Add table-driven builtin-skill cases for disabled, blocked, hidden, ineligible, and missing-requirement entries.
- [x] Run `node --test test/oneclaw-go-api.test.js` and confirm the new assertions fail for the intended reasons.

### Task 2: Harden runtime skill handling

**Files:**
- Modify: `src/integration/oneclaw.js`

- [x] Replace `os.tmpdir()` staging with a mode-0700 `<workspace>/.tmp` parent and a unique `oneclaw-skill-*` child.
- [x] Add a readiness-reason helper that treats explicit unusable fields as failures and accepts legacy name-only entries.
- [x] Include readiness reasons in builtin installation errors.
- [x] Run `node --test test/oneclaw-go-api.test.js` and confirm all cases pass.

### Task 3: Verify repository behavior

**Files:**
- Verify: `src/integration/oneclaw.js`
- Verify: `test/oneclaw-go-api.test.js`

- [x] Run `npm run lint`.
- [x] Run `node --test` and confirm zero failures.
- [x] Review `git diff --check` and the final diff for unrelated changes.
