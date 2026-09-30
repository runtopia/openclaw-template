# Browser lifecycle review — 2026-09-30

## Incident and changes

An idle task closure called back into the Wrapper while its maintenance loop held the same serial queue. The callback timed out and the plugin correctly persisted an uncertain execution lease, leaving the Runtime paused. The initial queue fix shipped in v4.3.6; an existing uncertain lease still requires targeted operator reconciliation.

The follow-up review covers task creation, viewing, manual takeover, native input, completion acknowledgements, handback, conversation switching, Runtime restart, final screenshot capture and idle process shutdown.

| Layer | Finding and resulting behavior |
| --- | --- |
| Wrapper maintenance | Plugin callbacks run outside the serial queue. Remaining task pages prevent shared shutdown until every task has saved its final frame and closed its pages. |
| Plugin authority | Global pause dominates task state, scoped pending inputs remain counted, and corrupt persisted task authority installs fail-closed guards while preserving the original file. |
| Input transport | The Wrapper reconciles lost completion acknowledgements before another task action. It never replays the original native input. Matching settled acknowledgements are idempotent; unknown or uncertain input stays blocked. |
| Handback and idle stop | A validated Wrapper stop lease is independent of page element snapshots. Model-authored page actions still require a new snapshot after handback. |
| Read-only diagnosis | `browser_use action=status` reports control state even while paused. It does not bypass admission or release unfinished leases. |
| Shared native viewer | Old input failures, polling responses and task-management responses cannot mutate a newly selected task. Global recovery is not offered as task-local recovery. |
| Preview readiness | A transient read-only capture failure invalidates the input frame until a fresh matching frame arrives; it does not discard the user's manual-control intent. Explicit visibility pause and uncertain input still require resumption. |
| Compact targets | Agent page actions reject compact aliases such as `t2` before admission and provide the current task's full target ID. A bare focus result cannot invent an alias page or bypass canonical task ownership. |
| Web | Runtime pause prevents task continuation and hides inappropriate task recovery. Existing viewer identity includes Workspace, Session and tool call. |
| Android | An open modal requests a fresh ticket when Session or tool call changes. |
| iOS | Reopening clears the previous URL and control epoch so a restarted Runtime's lower epoch can be accepted. |
| Docker deployment | An omitted browser flag inherits the image's enabled default. The API now applies the configured host seccomp profile in this case and rejects missing sandbox configuration before replacing a container. The staging host lacked this configuration. |
| Agent repair | Explicit shell commands that kill/restart shared Gateway or browser processes, or alter browser launch configuration, are rejected before a lease is admitted. Failed native browser startup must be reported to the operator. This is an admission guard for recognized repair commands, not a general shell sandbox. |
| API authorization | Reviewed owner authorization, one-time viewer tickets, runtime binding, redirects and WebSocket forwarding; these paths required no changes. |

## Verification

- Plugin: 60 targeted tests passed.
- Template: 309 tests passed and syntax lint passed, including real packaged-plugin callbacks, uncertainty retention, multiple-conversation final frame preservation, stale responses after task switching and recovery from transient preview failures.
- Isolated headed Chromium on the 101 test host: passed independent background input, Chinese/emoji input, wrong-token rejection, handback, popup ownership, stale-frame rejection, tab selection, lost acknowledgement reconciliation without input replay, idle reclamation and final snapshots for both conversations. The private test container has no network and uses a disposable profile.
- Web: 27 browser tests, TypeScript and targeted ESLint passed.
- Android: 19 browser tests, TypeScript and targeted ESLint passed. No Android device execution is claimed.
- API: targeted Workspace/browser deployment Go tests, source size checks, and the complete Go quality gate passed (format, dependencies, contract, test, vet and build).
- iOS: static verification, physical-device build/install, and all 8 browser XCTest cases passed on the connected iPhone. UI/background acceptance remains on the local Bug Board pending explicit user verification.

## Recovery constraints

Do not clear unknown execution leases, expire leases by age, replay browser inputs, or bypass pause through `exec`/CDP. Back up incident state before reconciling an exactly identified stale viewer close. Recheck that no other execution is pending, deploy the corrected Wrapper, and verify effective global and task state after restart.

The local ChatGPT Chrome extension connection is a separate incident: Chrome reported `Specified native messaging host not found` for the desktop bridge. The extension was installed and enabled. OneClaw Runtime changes cannot register that desktop application's bridge.

## Actual staging instance verification

The user's rebuilt staging container inherited browser-enabled image defaults but had no seccomp configuration. Native OpenClaw browser startup failed with namespace `Operation not permitted`; an Agent then sent SIGTERM to the shared Gateway through `exec`, interrupting two conversations. This explained the new paused state during acceptance testing, independently of the earlier idle callback deadlock.

On the test environment only, the API sandbox profile setting was backed up and configured, the API deployment fix was built and installed, and the target Runtime was recreated from develop commit `29bec4b` with the existing data volume, environment and port. The stopped previous container remains available for rollback. The two exactly identified interrupted `exec` records were backed up and drained only after the old process stopped; explicit operator recovery returned control to AI.

At 2026-09-30 11:16 (UTC+8), the actual Runtime's authenticated `/browser/start` and control status passed: `mode=ai`, `inFlight=0`, `browserReady=true`, with matching persisted control state. The same built candidate passed the isolated headed Chromium multi-conversation lifecycle checks again. User UI acceptance remains pending. No production state was reconciled or production instance updated in this acceptance stage; production has only the independent incident-state backup.
