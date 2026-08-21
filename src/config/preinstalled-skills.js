import fs from "node:fs";
import path from "node:path";

const DEFAULT_SKILLS_DIR = "/opt/oneclaw-skills";
const MANIFEST_NAME = ".preinstalled-manifest.json";
const SAFE_SKILL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function isExplicitlyDisabled(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isSkillFeatureEnabled(skill, env) {
  if (!skill.feature) return true;
  if (skill.feature === "documents") {
    return env.ONECLAW_RUNTIME_PROFILE === "full" || isTruthy(env.ONECLAW_DOCUMENT_SKILLS);
  }
  return false;
}

function normalizedSkillSlugs(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((value) => SAFE_SKILL_SLUG.test(value)))].sort();
}

function enabledBundleSkillSlugs(bundle, cfg, env) {
  if (!bundle) return [];
  return bundle.skills
    .filter((skill) =>
      skill.autoEnable === true
      && isSkillFeatureEnabled(skill, env)
      && cfg?.skills?.entries?.[skill.slug]?.enabled !== false)
    .map((skill) => skill.slug);
}

export function resolvePreinstalledSkills(env = process.env) {
  if (isExplicitlyDisabled(env.ONECLAW_PREINSTALLED_SKILLS_ENABLED)) return null;
  const root = path.resolve(env.ONECLAW_PREINSTALLED_SKILLS_DIR?.trim() || DEFAULT_SKILLS_DIR);
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const skills = (Array.isArray(manifest?.skills) ? manifest.skills : []).filter((skill) =>
      typeof skill?.slug === "string" &&
      SAFE_SKILL_SLUG.test(skill.slug) &&
      fs.existsSync(path.join(root, skill.slug, "SKILL.md")));
    return skills.length > 0 ? { root, skills } : null;
  } catch (err) {
    console.warn(`[skills] failed to read ${manifestPath}: ${err.message}`);
    return null;
  }
}

// Agent-level `skills` arrays are restrictive allowlists in OpenClaw. Merge
// globally enabled image-bundled skills into such lists so assigning one
// employee-specific skill cannot accidentally hide standard capabilities.
export function mergePreinstalledSkillAllowlist(cfg, values, env = process.env) {
  const bundle = resolvePreinstalledSkills(env);
  return normalizedSkillSlugs([
    ...normalizedSkillSlugs(values),
    ...enabledBundleSkillSlugs(bundle, cfg, env),
  ]);
}

// Image-bundled skills are loaded from immutable /opt at the lowest OpenClaw
// precedence. A user-installed skill in STATE_DIR/skills therefore overrides
// the image copy without startup-time copying or destructive upgrades.
export function applyPreinstalledSkillsDefaults(cfg, env = process.env) {
  const bundle = resolvePreinstalledSkills(env);
  if (!bundle || !cfg || typeof cfg !== "object") return false;

  let changed = false;
  if (!cfg.skills || typeof cfg.skills !== "object" || Array.isArray(cfg.skills)) {
    cfg.skills = {};
    changed = true;
  }
  if (!cfg.skills.load || typeof cfg.skills.load !== "object" || Array.isArray(cfg.skills.load)) {
    cfg.skills.load = {};
    changed = true;
  }
  const extraDirs = Array.isArray(cfg.skills.load.extraDirs)
    ? cfg.skills.load.extraDirs.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  if (!extraDirs.includes(bundle.root)) {
    cfg.skills.load.extraDirs = [...extraDirs, bundle.root];
    changed = true;
  }

  if (!cfg.skills.entries || typeof cfg.skills.entries !== "object" || Array.isArray(cfg.skills.entries)) {
    cfg.skills.entries = {};
    changed = true;
  }
  for (const skill of bundle.skills) {
    if (skill.autoEnable !== true) continue;
    const enabled = isSkillFeatureEnabled(skill, env);
    const existing = cfg.skills.entries[skill.slug];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cfg.skills.entries[skill.slug] = { enabled };
      changed = true;
    } else if (existing.enabled === undefined) {
      existing.enabled = enabled;
      changed = true;
    }
  }

  for (const agent of Array.isArray(cfg.agents?.list) ? cfg.agents.list : []) {
    if (!Array.isArray(agent?.skills)) continue;
    const merged = normalizedSkillSlugs([
      ...agent.skills,
      ...enabledBundleSkillSlugs(bundle, cfg, env),
    ]);
    if (JSON.stringify(agent.skills) !== JSON.stringify(merged)) {
      agent.skills = merged;
      changed = true;
    }
  }
  return changed;
}
