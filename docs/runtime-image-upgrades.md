# Runtime image upgrade contract

OneClaw employees do not select images directly. A Workspace uses the highest
runtime profile required by any installed employee skill:

- `standard`: instructions-only skills or skills whose binaries already ship
  in the standard image, including the common document workflows.
- `full`: a skill that adds a browser/system package, specialist CLI, Go tool,
  or Python/Node runtime that is not present in standard.

When publishing a skill, declare the minimum profile and its exact preflight
requirements in the catalog's `runtime_metadata`:

```json
{
  "runtime_profile": "full",
  "os": ["linux"],
  "requires": { "bins": ["example-cli"] },
  "install": [{ "kind": "node", "package": "example-cli@1.2.3", "bins": ["example-cli"] }]
}
```

For a new full dependency:

1. Pin and install it in the `runtime-full` Dockerfile stage. Do not install it
   at container startup.
2. Add its binary and skill slug to `scripts/write-runtime-capabilities.mjs` and
   `scripts/verify-linux-template-skills.sh`.
3. Set the skill's `runtime_metadata.runtime_profile` to `full` and list the
   required binaries/environment/config values.
4. Push through CI and release a `v*` tag. CI publishes both immutable profile
   tags, for example `2026.8.0-standard` and `2026.8.0-full`.
5. Update the OneClaw API image configuration to those two tags and redeploy the
   API. New deployments select the configured version; existing Workspaces move
   to it on an explicit redeploy or the next skill/employee reconciliation.

Pure prompt/SKILL.md updates do not require a new image unless their declared
runtime dependencies changed. A template/employee inherits the maximum profile
of its selected required and optional skills. Automatic downgrade from full is
intentionally disabled to avoid unnecessary restarts and dependency removal.
