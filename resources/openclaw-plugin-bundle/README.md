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
branch exactly equal to `origin/develop`. The resulting Template bundle is for
the `develop` integration branch and the 101 test environment. It validates and
tests Channel, runs typecheck and build, packs a tgz, names it with its SHA-256,
updates this bundle's manifest and lockfile, removes the superseded Channel
archive, and runs the bundle contract tests. It deliberately does not commit,
push, build an image, or restart a Runtime.

`develop` owns the local Channel tgz used by the 101 test environment; `main`
owns exact npm versions used by formal images. When promoting accepted Runtime
source from Template `develop` to `main`, keep `main`'s generated bundle files
instead of hand-merging tgz or lockfile changes. The formal release coordinator
updates the production bundle to the newly published npm version. After the
release, merge `main` back into `develop` and rerun this updater to regenerate
the test bundle.

## Formal npm and image release

Formal releases use committed `main` branches in both repositories. The
command below reads the plugin's committed `oneclaw.release.json`, pushes its
official release tag, waits for GitHub Actions trusted publishing to make the
exact npm artifacts visible, replaces any local `file:` bundle with those npm
versions, regenerates the lockfile, runs the Template tests, commits `main`,
and pushes a Template release tag:

```bash
npm run release:oneclaw-plugin -- oneclaw-channel --tag v4.1.4
```

Omit `--tag` to increment the latest stable Template tag's patch version. The
plugin repository defaults to `../oneclaw-plugins` and can be overridden with
`--plugin-repo`. Both repositories must be clean and exactly synchronized with
`origin/main`; uncommitted, ahead, behind, or non-main releases are rejected.

Only a pushed Template `v*` tag builds and publishes Runtime images. A normal
push to `main` and manual workflow dispatch do not build images.
