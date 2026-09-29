import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mediaPromiseBefore = "const pluginBoundMediaFieldsPromise = explicitOriginTargetsPlugin && parsedImages.length > 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});";
const mediaPromiseAfter = "const inlineMediaFieldsPromise = parsedImages.length > 0 && mediaPathOffloadPaths.length === 0 ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields) : Promise.resolve({});";
const applyFieldsBefore = "applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);";
const applyFieldsAfter = [
  "const inlineMediaFields = await inlineMediaFieldsPromise;",
  "\t\t\t\tif (explicitOriginTargetsPlugin || !(replyOptionImages?.length > 0)) applyChatSendManagedMediaFields(ctx, inlineMediaFields);",
].join("\n");
const legacyApplyFields = "const inlineMediaFields = await inlineMediaFieldsPromise;\n\t\t\t\tapplyChatSendManagedMediaFields(ctx, inlineMediaFields);";
const replyImagesBefore = "images: replyOptionImages,";
const legacyReplyImages = "images: inlineImagesUseManagedPaths ? void 0 : replyOptionImages,";
const legacyImageCount = "\t\t\t\tconst persistedInlineImageCount = Array.isArray(inlineMediaFields.MediaTypes) ? inlineMediaFields.MediaTypes.filter((type) => type.startsWith(\"image/\")).length : 0;\n";
const legacyManagedFlag = "\t\t\t\tconst inlineImagesUseManagedPaths = parsedImages.length > 0 && persistedInlineImageCount >= parsedImages.length;\n";

function replaceRequired(source, before, after, label) {
  if (source.includes(before)) return source.replace(before, after);
  if (source.includes(after)) return source;
  throw new Error(`OpenClaw chat image patch target not found: ${label}`);
}

export function patchOpenClawChatSource(source) {
  // Persisted paths are useful metadata, but their existence does not prove
  // media-understanding read them or described the correct image. Keep the
  // original current-turn bytes available to the reply runner as its fallback.
  // Legacy Web turns use those bytes directly: don't also hydrate the same
  // managed paths as duplicate native images. Plugin-bound turns still need
  // their managed paths, since the plugin owns its own dispatch pipeline.
  const migrated = source.replace(legacyReplyImages, replyImagesBefore)
    .replace(legacyImageCount, "").replace(legacyManagedFlag, "")
    .replace(legacyApplyFields, applyFieldsAfter);
  let patched = replaceRequired(migrated, mediaPromiseBefore, mediaPromiseAfter, "managed media promise");
  patched = replaceRequired(patched, applyFieldsBefore, applyFieldsAfter, "current-turn media fields");
  if (!patched.includes(replyImagesBefore)) throw new Error("OpenClaw chat image patch target not found: inline image fallback");
  return patched;
}

export function patchOpenClawChatBundle(openclawRoot) {
  if (!openclawRoot) throw new Error("OpenClaw package root directory required");
  const distDir = path.join(openclawRoot, "dist");
  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^chat-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes(mediaPromiseBefore) || source.includes(mediaPromiseAfter);
    });
  if (candidates.length !== 1) {
    throw new Error(`expected one OpenClaw chat bundle, found ${candidates.length}`);
  }
  const filePath = candidates[0];
  const source = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, patchOpenClawChatSource(source));
  console.log(`[patch] OpenClaw chat images patched: ${path.basename(filePath)}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) patchOpenClawChatBundle(process.argv[2]);
