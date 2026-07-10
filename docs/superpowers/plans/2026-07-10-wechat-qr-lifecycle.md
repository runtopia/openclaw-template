# WeChat QR Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop patched WeChat login work at the OneClaw binding deadline and propagate every refreshed QR URL back to the Go API without changing the Go contract.

**Architecture:** The runtime forwards the existing binding `expires_at` through the repair route to the patched plugin route. The package patch adds deadline/cancellation/refresh hooks to `waitForWeixinLogin`; the HTTP session owns one waiter and exposes its latest QR. WhatsApp remains on its request-driven Gateway RPC path and receives a cancellation regression test only.

**Tech Stack:** Node.js 22 ESM, Express, Node test runner, build-time JavaScript package patching.

---

### Task 1: Propagate the authoritative binding deadline

**Files:**
- Modify: `test/oneclaw-go-api.test.js`
- Modify: `src/integration/oneclaw.js`

- [ ] **Step 1: Write the failing runtime integration test**

Extend the WeChat bind test so its mocked `POST /repair/wechat-login/start` captures the body and asserts:

```js
assert.deepEqual(JSON.parse(opts.body), {
  accountId: "emp-1",
  expiresAt: bindingExpiresAt,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="wechat bind command enables" test/oneclaw-go-api.test.js`

Expected: FAIL because the request body does not contain `expiresAt`.

- [ ] **Step 3: Implement the minimal propagation**

Store the original ISO deadline on the active binding session and send it on the first WeChat start call:

```js
return repairFetch("wechat-login/start", "POST", {
  accountId: session.employeeId,
  expiresAt: session.expiresAtRaw,
});
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 2: Forward deadline, latest QR, and stop requests through repair

**Files:**
- Modify: `test/wechat-login-route.test.js`
- Modify: `src/repair/qr-login.js`

- [ ] **Step 1: Write failing repair-route tests**

Add separate tests proving:

```js
// start forwards the authoritative ISO deadline
assert.deepEqual(JSON.parse(pluginStartCall.opts.body), {
  accountId: "emp1",
  expiresAt,
});

// status replaces the cached QR with the route's refreshed value
assert.equal(statusData.qrUrl, refreshedQrUrl);

// stop reaches the plugin before wrapper state is cleared
assert.deepEqual(JSON.parse(pluginStopCall.opts.body), {
  sessionKey: "wechat-session-1",
});
```

- [ ] **Step 2: Run the focused route suite and verify RED**

Run: `node --test test/wechat-login-route.test.js`

Expected: FAIL because deadline forwarding, QR replacement, and plugin stop are missing.

- [ ] **Step 3: Implement minimal repair behavior**

In `startWechatPluginLogin`, forward `expiresAt`; in `getWechatPluginLoginState`, replace cached QR when status returns `qrDataUrl`/`qrUrl`; make `/wechat-login/stop` async and call `/qr-stop` with the active `sessionKey` before clearing local state. Preserve CLI fallback behavior.

- [ ] **Step 4: Run the focused route suite and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 3: Make the build-time plugin patch cancellable and QR-aware

**Files:**
- Modify: `test/weixin-http-route-patch.test.js`
- Modify: `scripts/patch-weixin-http-routes.js`

- [ ] **Step 1: Write failing package-patch contract tests**

Create a fixture containing `dist/index.js` and the pinned shape of `dist/src/auth/login-qr.js`. After `patchWeixinHttpRoutes(rootDir)`, assert that the generated package:

```js
assert.match(loginQr, /opts\.isCancelled/);
assert.match(loginQr, /opts\.deadlineAt/);
assert.match(loginQr, /opts\.onQrRefreshed/);
assert.match(route, /handleQrStop/);
assert.match(route, /qrDataUrl: session\.qrDataUrl/);
assert.match(route, /waiterStarted/);
```

Also run the patch twice and assert the second run leaves both files unchanged.

- [ ] **Step 2: Run the patch suite and verify RED**

Run: `node --test test/weixin-http-route-patch.test.js`

Expected: FAIL because the generated route has no stop/deadline/latest-QR behavior and the auth helper is not patched.

- [ ] **Step 3: Implement the minimal package patch**

Export a strict `patchLoginQrSource(source)` transformation that:

```js
const deadline = Math.min(
  Date.now() + timeoutMs,
  Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Number.POSITIVE_INFINITY,
);
```

It must check `opts.isCancelled?.()` before and after each upstream poll, delete the active login on cancellation, and invoke `opts.onQrRefreshed?.(activeLogin.qrcodeUrl, activeLogin.startedAt)` after each successful refresh.

Update generated HTTP route behavior to:

- parse and validate `expiresAt`;
- own exactly one waiter per live `sessionKey`;
- pass `deadlineAt`, `isCancelled`, and `onQrRefreshed` into `waitForWeixinLogin`;
- return `qrDataUrl`, `qrUpdatedAt`, and `expiresAt` from status;
- mark cancellation through `POST /qr-stop`;
- treat `alreadyConnected` as connected;
- purge/expire sessions on start, status, and stop.

- [ ] **Step 4: Run the patch suite and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 4: Verify refreshed QR reporting and cancellation boundaries

**Files:**
- Modify: `test/oneclaw-go-api.test.js`
- Modify only if the tests expose a defect: `src/integration/oneclaw.js`

- [ ] **Step 1: Write the refreshed-WeChat-QR regression test**

Mock start with `qr-old`, the next status with `qr-new`, then connected. Assert that channel state reports contain both QR values in order and use the same binding session id.

- [ ] **Step 2: Run it and verify RED or existing GREEN**

Run: `node --test --test-name-pattern="refreshed WeChat QR" test/oneclaw-go-api.test.js`

If it passes immediately, retain it as integration coverage because Task 2 changes the lower-layer contract; do not change production code unnecessarily.

- [ ] **Step 3: Write the late-WhatsApp-result regression test**

Keep a `web.login.wait` equivalent promise pending, cancel the binding, then resolve it with a new QR. Assert no channel-state report after cancellation contains that QR.

- [ ] **Step 4: Run the cancellation test**

Run: `node --test --test-name-pattern="late WhatsApp" test/oneclaw-go-api.test.js`

Expected: PASS with existing `session.cancelled` guard; if it fails, add only the missing guard and rerun.

### Task 5: Documentation and verification

**Files:**
- Modify: `docs/business-logic.md`

- [ ] **Step 1: Document the unified lifecycle**

Document that WeChat plugin HTTP sessions use the Go binding deadline, return refreshed QR URLs, and are cancelled through `/qr-stop`. State that `qr_expires_at` is omitted when upstream supplies no exact timestamp.

- [ ] **Step 2: Run focused verification**

Run:

```bash
node --test \
  test/wechat-login-route.test.js \
  test/weixin-http-route-patch.test.js \
  test/oneclaw-go-api.test.js \
  test/whatsapp-login-route.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run full repository verification**

Run: `npm test`

Expected: zero test failures.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only the planned files changed.
