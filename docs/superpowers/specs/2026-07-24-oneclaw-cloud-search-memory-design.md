# OneClaw Cloud Search and Memory Design

## Goal

Give hosted OpenClaw instances the same OneClaw-managed search and semantic-memory defaults as Desktop while keeping runtime state in the hosted instance.

## Ownership

- The OpenClaw instance owns memory source files, session transcripts, the local vector index, employee workspaces, and runtime configuration.
- ClawRouters owns embedding generation and the `/api/v1/search` route.
- SearXNG/Tavily credentials, provider fallback, response caching, and search Credits billing remain in ClawRouters.
- The instance receives only its existing user-scoped `CLAWROUTERS_API_KEY`.

## Runtime behavior

- Fresh configuration and persisted-volume redeploys both run `applyRuntimeDefaults()`.
- With a ClawRouters credential, memory search uses provider `clawrouters`, model `auto`, sources `memory` and `sessions`, and the normalized `/api/v1` base URL.
- The image bundles the first-party `oneclaw-search` OpenClaw plugin outside `/data`, loads it through `plugins.load.paths`, and enables it through `plugins.entries`.
- If no web-search provider is selected, the runtime selects `oneclaw-search` and enables `web_search`.
- An explicitly selected provider and an explicit `enabled=false` are preserved.
- Search requests use the ClawRouters child key, identify the client platform as `cloud`, and wrap returned titles and snippets as untrusted web content.

## Upgrade behavior

The `/data` volume may contain an older `openclaw.json`. Startup patches plugin discovery, plugin activation, memory defaults, and the default search selection in place, so existing instances gain these capabilities after the new image is deployed without losing user choices.

## Validation

- Config tests cover fresh generation, existing configuration, explicit provider preservation, and explicit opt-out preservation.
- Plugin contract tests cover the manifest, image discovery path, cloud authentication header, and external-content wrapping.
- The plugin must load against the exact OpenClaw version pinned by the Dockerfile.
