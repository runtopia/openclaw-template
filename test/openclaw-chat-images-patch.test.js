import assert from "node:assert/strict";
import test from "node:test";

import { patchOpenClawChatSource } from "../scripts/patch-openclaw-chat-images.js";

const fixture = `
const pluginBoundMediaFieldsPromise = explicitOriginTargetsPlugin && parsedImages.length > 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});
measureDiagnosticsTimelineSpan("gateway.chat_send.dispatch_inbound", async () => {
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
  assert.match(patched, /const inlineImagesUseManagedPaths = parsedImages\.length > 0/);
  assert.match(patched, /images: inlineImagesUseManagedPaths \? void 0 : replyOptionImages/);
  assert.doesNotMatch(patched, /pluginBoundMediaFieldsPromise/);
});

test("patch is idempotent", () => {
  const once = patchOpenClawChatSource(fixture);
  assert.equal(patchOpenClawChatSource(once), once);
});
