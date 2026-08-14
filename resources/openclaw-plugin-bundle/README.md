# OpenClaw plugin bundle

This is the cloud Runtime's consumer lockfile, not a plugin workspace. Each
plugin owns its source, package manifest, and internal dependencies in its own
repository/package. The template declares only the exact top-level versions it
installs into `/opt/openclaw-plugins` during the image build.

Refresh `package-lock.json` with Node.js 24.15.0 and npm 11.19.0 whenever a
declared plugin version changes.

From the repository root, check for new `@oneclaw-plugins/*` releases without
changing files:

```bash
npm run check:oneclaw-plugins
```

Update every declared OneClaw plugin to its npm `latest` dist-tag, keeping exact
versions in both the manifest and lockfile:

```bash
npm run update:oneclaw-plugins
```

Both commands query the official npm registry by default. Set
`ONECLAW_NPM_REGISTRY` only when an alternative registry is intentionally
required. The check command exits with status 1 when updates are available, so
it can also be used as a CI freshness check.

For an unreleased Channel change, build and content-address the sibling
`oneclaw-plugins` repository instead of publishing or querying npm:

```bash
npm run update:local-channel
```

The default plugin repository is `../oneclaw-plugins`. Override it when the
repositories are not siblings:

```bash
npm run update:local-channel -- --plugin-repo /path/to/oneclaw-plugins
```

The command requires `oneclaw-plugins` to be on a clean, committed `develop`
branch exactly equal to `origin/develop`. It validates and tests Channel, runs typecheck and build, packs a tgz, names it with its SHA-256,
updates this bundle's manifest and lockfile, removes the superseded Channel
archive, and runs the bundle contract tests. It deliberately does not commit,
push, build an image, or restart a Runtime.
