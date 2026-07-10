# WeChat QR Lifecycle Design

## Goal

Make the OneClaw binding deadline authoritative across the Go API, template wrapper, and patched WeChat plugin route. A cancelled or expired binding must stop producing refreshed QR codes, and every QR refresh that occurs before the deadline must reach the dashboard through the existing runtime state reporting path.

## Current problem

The platform binding session expires after five minutes by default, while the patched WeChat plugin starts an independent `waitForWeixinLogin` task with its own eight-minute timeout. The wrapper stops polling at the platform deadline but cannot cancel that background task. The plugin also updates only its private `activeLogin.qrcodeUrl` when it refreshes a QR code; the patched HTTP session and `/qr-status` response retain the original URL.

This creates three observable failures:

1. The plugin may continue polling and printing refreshed QR codes after the OneClaw binding has expired or been cancelled.
2. The dashboard can keep displaying the original expired QR while the terminal shows a newer QR.
3. The route contract suggests that `qrExpiresAt` may exist, but the pinned WeChat plugin does not provide a reliable per-QR expiry timestamp.

## Scope

The implementation changes only `openclaw-template-v2`. The Go API already creates and enforces the authoritative binding deadline and does not need a contract change.

WhatsApp remains on the existing Gateway RPC path. Its `web.login.wait` call already returns the latest QR and the template forwards `currentQrDataUrl`, so it does not have the stale-QR defect. Cancellation can leave one in-flight RPC call running for up to its request timeout, but the template already checks `session.cancelled` before reporting its result. This change adds regression coverage for that boundary but does not restart or globally stop the Gateway.

## Architecture

### Authoritative deadline

`binding.expires_at` from the Go API remains the single total binding deadline.

The template passes the ISO deadline to `POST /repair/wechat-login/start`. The repair route forwards it to the patched plugin `POST /plugins/openclaw-weixin/qr-start`. The plugin route converts it to an absolute millisecond deadline, clamps the background wait to the remaining duration, and marks the session expired when that deadline is reached.

No layer extends this total deadline when an individual QR code is refreshed.

### Cancellable plugin wait

The package patch extends the pinned plugin's `waitForWeixinLogin` options with three optional hooks:

- `deadlineAt`: absolute total deadline in milliseconds.
- `isCancelled`: checked before and after each upstream long poll and before any QR refresh.
- `onQrRefreshed`: receives the latest QR URL after a successful refresh.

The route adds `POST /qr-stop`. Stopping sets the session cancellation flag and terminal state before clearing wrapper state. A currently running upstream long poll may finish, but its result is discarded and it cannot trigger another refresh or successful binding transition.

### QR synchronization

The HTTP session stores the current `qrDataUrl` and `qrUpdatedAt`. `onQrRefreshed` updates both fields. `GET /qr-status` returns them with the business status.

The wrapper updates its cached QR whenever `/qr-status` returns a new value. The existing integration loop then reports that URL to `/agent/channels/state`, so the Go API and dashboard receive the refreshed QR without a new binding session.

The implementation does not invent `qrExpiresAt`. It remains absent unless a future plugin version exposes a real timestamp.

### Session ownership and idempotency

Only one background waiter is allowed per plugin `sessionKey`. Reusing an active start returns the existing HTTP session rather than starting a second waiter. A stopped, expired, failed, or connected session is terminal.

The plugin route's session cleanup runs on start, status, and stop requests. Cleanup removes terminal sessions after the route retention period, but cleanup is not used as the cancellation mechanism.

## Error handling

- An invalid or already-expired `expiresAt` is rejected by the repair/plugin route instead of starting a login that can never complete.
- A missing plugin session returns a terminal not-found response; the wrapper reports failure rather than reusing a stale QR.
- Cancellation and deadline expiry are represented separately from upstream login failure so normal user cancellation does not produce an error message.
- `alreadyConnected` is treated as a successful terminal result rather than a failed login.
- The existing CLI fallback remains available when the patched plugin HTTP route is unavailable. CLI cancellation continues to kill the spawned process.

## Testing

Tests are added before production changes and cover:

1. The runtime passes the authoritative binding deadline into the WeChat repair start request.
2. The repair route forwards the deadline to `/qr-start` and calls `/qr-stop` with the active `sessionKey` before clearing state.
3. A refreshed `qrDataUrl` returned by `/qr-status` replaces the cached URL and is reported to the Go API.
4. The generated plugin patch contains and wires deadline, cancellation, refresh callback, latest-QR status, and stop-route behavior.
5. An existing active plugin session does not start a second background waiter.
6. WhatsApp cancellation ignores a late in-flight wait result and does not report a new QR after cancellation.

The focused Node test suites run after every TDD cycle, followed by the repository's full test command.

## Non-goals

- Changing the Go API binding schema or default TTL.
- Predicting a per-QR expiry timestamp that WeChat does not expose.
- Replacing the WeChat plugin's authentication protocol.
- Restarting the Gateway to cancel a single channel binding.
- Adding a new WhatsApp Gateway RPC method.
