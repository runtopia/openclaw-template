import assert from "node:assert/strict";
import test from "node:test";
import { filterScenarioCapabilities } from "../src/integration/scenario-capabilities.js";

const manifest = {
  schema_version: 1,
  groups: [{ id: "scenarios" }, { id: "gmail" }],
  actions: [
    { id: "scenario.resume_v1", group_id: "scenarios" },
    { id: "scenario.outfit_v1", group_id: "scenarios" },
    { id: "scenario.unknown", group_id: "scenarios" },
    { id: "gmail.latest_emails", group_id: "gmail" },
  ],
};

test("scenario executors require actual document and media capabilities", () => {
  const result = filterScenarioCapabilities(manifest, {
    capabilities: ["documents", "media"], supported_skills: ["pdf", "docx"],
  });
  assert.deepEqual(result.actions.map(action => action.id), [
    "scenario.resume_v1", "scenario.outfit_v1", "gmail.latest_emails",
  ]);
  assert.equal(manifest.actions.length, 4);
});

test("missing document tools hide resume even when media works", () => {
  const result = filterScenarioCapabilities(manifest, { capabilities: ["media"], supported_skills: ["pdf"] });
  assert.deepEqual(result.actions.map(action => action.id), ["scenario.outfit_v1", "gmail.latest_emails"]);
});

test("unknown capabilities hide the empty scenario group, not existing integrations", () => {
  const result = filterScenarioCapabilities(manifest, null);
  assert.deepEqual(result.groups, [{ id: "gmail" }]);
  assert.deepEqual(result.actions.map(action => action.id), ["gmail.latest_emails"]);
});
