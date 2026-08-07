import assert from "node:assert/strict";
import test from "node:test";

import {
  patchOneclawChannelDeliverySource,
} from "../scripts/patch-oneclaw-channel-delivery.mjs";

const fixture = `
const ONECLAW_DELIVERY_GUIDANCE = [
  "Deliver outcomes in the form that best matches the work, not as technical execution logs.",
  "When the requested outcome is naturally a file (for example a report, document, spreadsheet, presentation, generated image, or edited media), create the file inside an OpenClaw-authorized workspace/media path and deliver it through the native message tool using mediaUrl or mediaUrls. Do not replace a requested file deliverable with Markdown alone.",
  "After the native message tool has delivered the complete final outcome, return NO_REPLY so the user does not receive a duplicate answer."
].join("\\n");
function registerDeliveryPromptHook(api) {
\tapi.on("before_prompt_build", (_event, context) => {
\t\tif (context.channelId !== "oneclaw" && context.messageProvider !== "oneclaw") return;
\t\treturn { appendSystemContext: ONECLAW_DELIVERY_GUIDANCE };
\t});
}
function configureOneClawControlGateway() {}
function registerSideEffectHooks() {}
function registerNativeCronPlanProjectionHooks() {}
const oneclawPlugin = {};
const plugin = {
\tregister(api) {
\t\tconfigureOneClawControlGateway(api.runtime?.gateway);
\t\tregisterDeliveryPromptHook(api);
\t\tregisterSideEffectHooks(api);
\t\tregisterNativeCronPlanProjectionHooks(api);
\t\tapi.registerChannel({ plugin: oneclawPlugin });
\t}
};
`;

test("patch routes OneClaw text, image, and HTML delivery through generic send", () => {
  const patched = patchOneclawChannelDeliverySource(fixture);

  assert.match(patched, /action=\\\"send\\\" for every OneClaw delivery/);
  assert.match(patched, /ordinary text, images, and files such as HTML/);
  assert.match(patched, /absolute path through mediaUrl or mediaUrls/);
  assert.match(patched, /never use provider-specific actions such as sendAttachment or upload-file/);
  assert.match(patched, /registerOneClawMessageDeliveryHook\(api\)/);
  assert.doesNotThrow(() => new Function(patched));
});

test("patch normalizes OneClaw-only file actions without changing explicit cross-channel actions", () => {
  const patched = patchOneclawChannelDeliverySource(fixture);
  const hooks = new Function(`${patched}
    const hooks = [];
    plugin.register({
      runtime: { gateway: {} },
      on: (name, handler) => hooks.push({ name, handler }),
      registerChannel() {},
    });
    return hooks;
  `)();
  const normalizer = hooks
    .filter((entry) => entry.name === "before_tool_call")
    .map((entry) => entry.handler)
    .find((handler) => handler(
      { toolName: "message", params: { action: "sendAttachment", filePath: "/tmp/report.html" } },
      { channelId: "oneclaw" },
    )?.params?.action === "send");

  assert.ok(normalizer);
  assert.deepEqual(
    normalizer(
      { toolName: "message", params: { action: "upload-file", filePath: "/tmp/report.html" } },
      { channelId: "oneclaw" },
    ),
    { params: { action: "send", filePath: "/tmp/report.html" } },
  );
  assert.equal(
    normalizer(
      { toolName: "message", params: { action: "upload-file", channel: "slack" } },
      { channelId: "oneclaw" },
    ),
    undefined,
  );
});

test("OneClaw delivery patch is idempotent", () => {
  const once = patchOneclawChannelDeliverySource(fixture);
  assert.equal(patchOneclawChannelDeliverySource(once), once);
});

test("OneClaw delivery patch fails closed when the package anchor changes", () => {
  assert.throws(
    () => patchOneclawChannelDeliverySource("const guidance = 'changed upstream';"),
    /delivery guidance anchor was not found/,
  );
});
