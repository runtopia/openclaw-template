import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPreinstalledSkillsDefaults,
  resolvePreinstalledSkills,
} from "../src/config/preinstalled-skills.js";

function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-preinstalled-skills-"));
  fs.mkdirSync(path.join(root, "pdf"), { recursive: true });
  fs.mkdirSync(path.join(root, "xlsx"), { recursive: true });
  fs.writeFileSync(path.join(root, "pdf", "SKILL.md"), "# PDF\n");
  fs.writeFileSync(path.join(root, "xlsx", "SKILL.md"), "# XLSX\n");
  fs.writeFileSync(path.join(root, ".preinstalled-manifest.json"), JSON.stringify({
    skills: [
      { slug: "pdf", feature: "documents", autoEnable: true },
      { slug: "xlsx", autoEnable: true },
      { slug: "missing", autoEnable: true },
      { slug: "../unsafe", autoEnable: true },
    ],
  }));
  return root;
}

test("preinstalled skills load from an immutable extra directory without overriding opt-outs", (t) => {
  const root = createBundle();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = {
    skills: {
      load: { extraDirs: ["/custom/skills"] },
      entries: { pdf: { enabled: false, env: { EXISTING: "1" } } },
    },
  };

  assert.equal(applyPreinstalledSkillsDefaults(cfg, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_DOCUMENT_SKILLS: "1",
  }), true);
  assert.deepEqual(cfg.skills.load.extraDirs, ["/custom/skills", root]);
  assert.deepEqual(cfg.skills.entries.pdf, { enabled: false, env: { EXISTING: "1" } });
  assert.deepEqual(cfg.skills.entries.xlsx, { enabled: true });
  assert.equal(cfg.skills.entries.missing, undefined);
  assert.equal(applyPreinstalledSkillsDefaults(cfg, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_DOCUMENT_SKILLS: "1",
  }), false);
});

test("document skills stay disabled in the lean image and enable in document/full builds", (t) => {
  const root = createBundle();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const lean = {};
  applyPreinstalledSkillsDefaults(lean, { ONECLAW_PREINSTALLED_SKILLS_DIR: root });
  assert.equal(lean.skills.entries.pdf.enabled, false);
  assert.equal(lean.skills.entries.xlsx.enabled, true);

  const documents = {};
  applyPreinstalledSkillsDefaults(documents, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_DOCUMENT_SKILLS: "1",
  });
  assert.equal(documents.skills.entries.pdf.enabled, true);

  const full = {};
  applyPreinstalledSkillsDefaults(full, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_RUNTIME_PROFILE: "full",
  });
  assert.equal(full.skills.entries.pdf.enabled, true);
});

test("globally enabled preinstalled skills are added to every restrictive agent allowlist", (t) => {
  const root = createBundle();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = {
    agents: {
      list: [
        { id: "main", skills: ["custom"] },
        { id: "unrestricted" },
      ],
    },
    skills: { entries: { pdf: { enabled: false } } },
  };

  applyPreinstalledSkillsDefaults(cfg, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_DOCUMENT_SKILLS: "1",
  });

  assert.deepEqual(cfg.agents.list[0].skills, ["custom", "xlsx"]);
  assert.equal(cfg.agents.list[1].skills, undefined);
});

test("preinstalled skills can be disabled and malformed bundles are ignored", (t) => {
  const root = createBundle();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolvePreinstalledSkills({
    ONECLAW_PREINSTALLED_SKILLS_DIR: root,
    ONECLAW_PREINSTALLED_SKILLS_ENABLED: "false",
  }), null);
  assert.equal(applyPreinstalledSkillsDefaults({}, {
    ONECLAW_PREINSTALLED_SKILLS_DIR: path.join(root, "missing"),
  }), false);
});

test("message channel skill delegates credential setup to the OneClaw app", () => {
  const skill = fs.readFileSync(path.join(
    process.cwd(),
    "resources",
    "preinstalled-skills",
    "manage-message-channels",
    "SKILL.md",
  ), "utf8");

  assert.match(skill, /#\/channels\?setup=<id>/u);
  assert.match(skill, /Never ask the user to paste a token/u);
  assert.match(skill, /Telegram \(`telegram`\)/u);
});

test("Gmail skill uses the deterministic local workflow and OneClaw authorization card", () => {
  const skill = fs.readFileSync(path.join(
    process.cwd(),
    "resources",
    "preinstalled-skills",
    "composio-gmail",
    "SKILL.md",
  ), "utf8");

  assert.match(skill, /\/opt\/oneclaw-skills\/composio-gmail\/run\.py/u);
  assert.match(skill, /latest_emails/u);
  assert.match(skill, /read_email/u);
  assert.match(skill, /search_integrations/u);
  assert.match(skill, /use_integration/u);
  assert.match(skill, /--max-results 5/u);
  assert.match(skill, /Search results intentionally omit full message payloads/u);
  assert.match(skill, /Never request OAuth tokens/u);
  assert.match(skill, /Do not use `search_integrations` or `use_integration` for normal email reads/u);
});
