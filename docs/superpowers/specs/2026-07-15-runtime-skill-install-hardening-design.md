# Runtime Skill Install Hardening

## Goal

Make OneClaw custom skill installation independent of system `/tmp` permissions and ensure builtin skills are reported available only when their runtime status is usable.

## Design

Custom archives are staged below `${OPENCLAW_WORKSPACE_DIR}/.tmp`. The integration creates this private parent directory before calling `mkdtemp`, installs from the extracted local directory, and removes the unique temporary directory in `finally`.

Builtin skill resolution continues to support legacy `skills.status` entries that only contain a name. When readiness fields are present, an entry is rejected if it is disabled, ineligible, blocked by an allowlist or agent filter, hidden from the model, or has missing requirements. The failure includes the applicable reasons.

## Testing

Regression tests verify workspace-local staging and cleanup, legacy builtin compatibility, and rejection of disabled, blocked, or dependency-incomplete builtin skills.
