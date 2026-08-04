# OpenClaw plugin bundle

This is the cloud Runtime's consumer lockfile, not a plugin workspace. Each
plugin owns its source, package manifest, and internal dependencies in its own
repository/package. The template declares only the exact top-level versions it
installs into `/opt/openclaw-plugins` during the image build.

Refresh `package-lock.json` with Node.js 24.15.0 and npm 11.19.0 whenever a
declared plugin version changes.
