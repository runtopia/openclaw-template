# Chromium sandbox for Docker Runtime

`seccomp_profile.json` is the Playwright Chromium Docker profile, retrieved on
2026-09-28 from https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json.
The upstream Apache-2.0 license is included as `LICENSE.playwright`.
It retains a syscall allowlist and permits the user-namespace operations needed
by Chromium. Run the browser as the existing non-root Runtime user (1001).
Do not add `--privileged`, `SYS_ADMIN`, or `seccomp=unconfined`.

Copy the profile to a persistent absolute path on the Docker host. For direct
deployment, pass `--security-opt seccomp=/absolute/path/seccomp_profile.json`
and `-e ONECLAW_BROWSER_NO_SANDBOX=0`. This explicitly removes an earlier
persisted `browser.noSandbox=true` recovery setting. Container recreation is
required to change the seccomp profile; preserve the data volume and keep the
old stopped container until the replacement has passed acceptance.

OneClaw API can pass the same options on future Docker deployments through
`External.openclaw_browser_seccomp_profile`. The value is a path on the Docker
host, not inside the Runtime or API container. It applies only to deployments
with `ONECLAW_BROWSER_ENABLED=1`. Providers that do not support namespace
sandboxing need their own isolation configuration; this profile cannot change
a managed provider's host policy.

## Display quality

The default display is 2560×1600 physical pixels with Chromium device scale 2
(approximately 1280×800 logical pixels before browser chrome). Both Web and
the embedded mobile viewer request noVNC quality level 9. This improves text
definition without making controls half their usual size.

Operators can set `ONECLAW_BROWSER_WIDTH` (1280–3840),
`ONECLAW_BROWSER_HEIGHT` (800–2160), and `ONECLAW_BROWSER_SCALE_FACTOR` (1 or 2).
Invalid values fall back to defaults. Display changes require a Runtime restart.
Viewer panels scale this shared desktop; resizing a panel does not resize the
remote desktop or change other viewers' input coordinates.
