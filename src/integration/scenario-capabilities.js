// Product recipes live in API settings. The image only declares executors.
export function filterScenarioCapabilities(manifest, runtimeCapabilities) {
  const capabilities = new Set(runtimeCapabilities?.capabilities || []);
  const skills = new Set(runtimeCapabilities?.supported_skills || []);
  const actions = manifest.actions.filter((action) => {
    if (action.id === "scenario.resume_v1") {
      return capabilities.has("documents") && skills.has("docx") && skills.has("pdf");
    }
    if (action.id === "scenario.outfit_v1") return capabilities.has("media");
    return !String(action.id).startsWith("scenario.");
  });
  return {
    ...manifest,
    actions,
    groups: manifest.groups.filter((group) =>
      group.id !== "scenarios" || actions.some((action) => action.group_id === "scenarios")),
  };
}
