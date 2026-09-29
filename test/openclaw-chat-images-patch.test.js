import assert from "node:assert/strict";
import test from "node:test";

import { patchOpenClawChatSource } from "../scripts/patch-openclaw-chat-images.js";

const fixture = `
const pluginBoundMediaFieldsPromise = explicitOriginTargetsPlugin && parsedImages.length > 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});
await measureDiagnosticsTimelineSpan("gateway.chat_send.dispatch_inbound", async () => {
\tapplyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
\tconst dispatchResult = await dispatchInboundMessage({
\t\treplyOptions: {
\t\t\timages: replyOptionImages,
\t\t},
\t});
});
`;

test("patch exposes persisted chat images as current-turn managed media", () => {
  const patched = patchOpenClawChatSource(fixture);

  assert.match(patched, /const inlineMediaFieldsPromise = parsedImages\.length > 0 && mediaPathOffloadPaths\.length === 0/);
  assert.match(patched, /applyChatSendManagedMediaFields\(ctx, inlineMediaFields\)/);
  assert.match(patched, /images: replyOptionImages/);
  assert.doesNotMatch(patched, /inlineImagesUseManagedPaths/);
  assert.doesNotMatch(patched, /pluginBoundMediaFieldsPromise/);
});

test("patch is idempotent", () => {
  const once = patchOpenClawChatSource(fixture);
  assert.equal(patchOpenClawChatSource(once), once);
});


test("migrates the earlier patch without discarding valid inline image bytes", () => {
  const previous = fixture
    .replace("const pluginBoundMediaFieldsPromise = explicitOriginTargetsPlugin && parsedImages.length > 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});", "const inlineMediaFieldsPromise = parsedImages.length > 0 && mediaPathOffloadPaths.length === 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});")
    .replace("applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);", "const inlineMediaFields = await inlineMediaFieldsPromise;\n\t\t\t\tapplyChatSendManagedMediaFields(ctx, inlineMediaFields);\n\t\t\t\tconst persistedInlineImageCount = Array.isArray(inlineMediaFields.MediaTypes) ? inlineMediaFields.MediaTypes.filter((type) => type.startsWith(\"image/\")).length : 0;\n\t\t\t\tconst inlineImagesUseManagedPaths = parsedImages.length > 0 && persistedInlineImageCount >= parsedImages.length;")
    .replace("images: replyOptionImages,", "images: inlineImagesUseManagedPaths ? void 0 : replyOptionImages,");
  const patched = patchOpenClawChatSource(previous);
  assert.match(patched, /images: replyOptionImages/);
  assert.doesNotMatch(patched, /inlineImagesUseManagedPaths|persistedInlineImageCount/);
  assert.equal(patchOpenClawChatSource(patched), patched);
});

test("dispatch receives original bytes even when managed media has no native image", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("parsedImages", "replyOptionImages", "pluginBound", `
    const explicitOriginTargetsPlugin = pluginBound;
    const mediaPathOffloadPaths = [];
    const preparedUserTurnMediaPromise = Promise.resolve({ MediaTypes: ['image/png'] });
    const resolveChatSendManagedMediaFields = value => value;
    const ctx = {};
    const applyChatSendManagedMediaFields = (ctx, value) => Object.assign(ctx, value);
    let received;
    const dispatchInboundMessage = async options => { received = options.replyOptions.images; };
    const measureDiagnosticsTimelineSpan = (_, callback) => callback();
    ${patchOpenClawChatSource(fixture)}
    return { received, ctx };
  `);
  const image = { type: 'image', mimeType: 'image/png', data: 'original-red-image' };
  const web = await run([image], [image], false);
  assert.deepEqual(web.received, [image]);
  assert.deepEqual(web.ctx, {}); // No duplicate managed paths for the native runner.
  const plugin = await run([image], [image], true);
  assert.deepEqual(plugin.received, [image]);
  assert.deepEqual(plugin.ctx.MediaTypes, ['image/png']);
  const managedOnly = await run([image], [], false);
  assert.deepEqual(managedOnly.ctx.MediaTypes, ['image/png']);
});
