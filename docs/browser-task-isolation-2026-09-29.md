# Browser task transport

The shared desktop stays available for legacy Workspace viewing. Task cards
use a separate page-scoped transport backed by the existing authenticated
Runtime session or Gateway connection. It does not focus the page or create a
second Chromium profile. Cookies remain shared within the Workspace.

- Resolve: `browseruse.control {action:status,sessionKey,toolCallId}` or native
  `/browser/task-resolve {sessionId,toolCallId}` returns `browserTaskId`,
  `generation`, `targetId`, `resourceState` and task phase.
- Preview: `browseruse.preview` or `/browser/task-preview` requires exact task
  identity. `viewer:true` selects higher resolution. Archived/expired tasks
  return their persisted frame only.
- Control: `browseruse.task` or `/browser/task-control` accepts the task ID and
  action. The Runtime generates control tokens; `browseruse.task-authority`
  checks ownership, generation, heartbeat and in-flight operations.
- Input: allowlisted pointer, scroll, committed text and navigation keys only.
  The broker derives the actual target from authority, validates loopback CDP,
  and acknowledges every input lease. No evaluate/javascript input endpoint.
- Retention: `/browser/task-manage` maps retain/unretain/close-task to the same
  plugin authority. Closure saves a real frame before removing pages.

Native applications call the shared Runtime task viewer. Web cards use the same
Gateway methods. Closing a control view pauses; returning from background needs
explicit resume. If a token is lost, only a drained paused task can recover.
Uncertain input cannot be released or recovered by timeout.

Reproducible live check: `scripts/verify-browser-task-live.mjs`, with
`BROWSER_USE_SOURCE_DIR` pointing to the plugin source. Run as a non-root user in
an isolated container with the repository Chromium seccomp profile. The script
creates a private X display/profile and data-only pages, then verifies that B
navigates/comes to the foreground while human input still reaches A (Chinese and
emoji), screenshot capture, token rejection and handback. No account or network
credentials are needed. The first run inside the existing test container failed
because its sandbox configuration was missing; the isolated sandboxed run passed.

Device verification and deployment results are recorded in the Web repository's
browser lifecycle implementation log. Do not treat unit or live-broker tests as
proof of completed Android/iOS UI acceptance.
