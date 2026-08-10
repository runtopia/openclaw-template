#!/usr/bin/env node
/**
 * Keep OneClaw artifact delivery on OpenClaw's channel-neutral send action.
 *
 * OpenClaw exposes provider-specific message actions such as sendAttachment
 * (iMessage) and upload-file (selected provider plugins) in the shared
 * message-tool schema. OneClaw delivers text and every artifact type through
 * the generic `send` action plus mediaUrl/mediaUrls. Make that distinction
 * explicit in the bundled Channel prompt and normalize accidental file-action
 * aliases at the tool boundary so they never reach a provider-specific
 * actions.handleAction implementation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_PATH = join("dist", "index.mjs");
const ORIGINAL_GUIDANCE = "When the requested outcome is naturally a file (for example a report, document, spreadsheet, presentation, generated image, or edited media), create the file inside an OpenClaw-authorized workspace/media path and deliver it through the native message tool using mediaUrl or mediaUrls. Do not replace a requested file deliverable with Markdown alone.";
// This value is inserted inside an already double-quoted compiled string, so
// retain the source-level escapes around "send".
const PATCHED_GUIDANCE = "Use the native message tool with action=\\\"send\\\" for every OneClaw delivery, including ordinary text, images, and files such as HTML; never use provider-specific actions such as sendAttachment or upload-file. For a file or image, create it inside an OpenClaw-authorized workspace/media path and pass its absolute path through mediaUrl or mediaUrls. Do not replace a requested file deliverable with Markdown alone.";
const DELIVERY_PROMPT_HOOK = `function registerDeliveryPromptHook(api) {
\tapi.on("before_prompt_build", (_event, context) => {
\t\tif (context.channelId !== "oneclaw" && context.messageProvider !== "oneclaw") return;
\t\treturn { appendSystemContext: ONECLAW_DELIVERY_GUIDANCE };
\t});
}`;
const DELIVERY_ACTION_NORMALIZER = `${DELIVERY_PROMPT_HOOK}
const ONECLAW_FILE_DELIVERY_ACTIONS = new Set(["sendAttachment", "upload-file"]);
function registerOneClawMessageDeliveryHook(api) {
\tapi.on("before_tool_call", (event, context) => {
\t\tif (event.toolName !== "message" || !ONECLAW_FILE_DELIVERY_ACTIONS.has(event.params.action)) return;
\t\tconst explicitChannel = typeof event.params.channel === "string" ? event.params.channel.trim() : "";
\t\tconst channel = explicitChannel || context.channelId;
\t\tif (channel !== "oneclaw" && channel !== "oneclaw-channel") return;
\t\treturn { params: { ...event.params, action: "send" } };
\t});
}`;
const REGISTER_HOOKS_ORIGINAL = `\t\tregisterDeliveryPromptHook(api);
\t\tregisterSideEffectHooks(api);`;
const REGISTER_HOOKS_PATCHED = `\t\tregisterDeliveryPromptHook(api);
\t\tregisterOneClawMessageDeliveryHook(api);
\t\tregisterSideEffectHooks(api);`;

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (source.includes(before)) return source.replace(before, after);
  throw new Error(
    `[patch-oneclaw-channel-delivery] ${label} anchor was not found; `
    + "review the patch before changing the bundled Channel version.",
  );
}

export function patchOneclawChannelDeliverySource(source) {
  let patched = replaceRequired(
    source,
    ORIGINAL_GUIDANCE,
    PATCHED_GUIDANCE,
    "delivery guidance",
  );
  patched = replaceRequired(
    patched,
    DELIVERY_PROMPT_HOOK,
    DELIVERY_ACTION_NORMALIZER,
    "delivery prompt hook",
  );
  return replaceRequired(
    patched,
    REGISTER_HOOKS_ORIGINAL,
    REGISTER_HOOKS_PATCHED,
    "plugin hook registration",
  );
}

export function patchOneclawChannelDelivery(packageRoot) {
  if (!packageRoot) throw new Error("OneClaw Channel package root directory required");
  const filePath = join(packageRoot, ENTRY_PATH);
  const source = readFileSync(filePath, "utf8");
  const patched = patchOneclawChannelDeliverySource(source);
  if (patched === source) return false;
  writeFileSync(filePath, patched, "utf8");
  console.log(`[patch-oneclaw-channel-delivery] Patched: ${ENTRY_PATH}`);
  return true;
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) patchOneclawChannelDelivery(process.argv[2]);
