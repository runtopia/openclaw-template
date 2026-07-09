import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let cachedConversationRuntime = null;
let cachedConversationRuntimePath = "";

export function resolveOpenClawEntryFromClawArgs(clawArgs) {
  if (typeof clawArgs !== "function") return "";
  try {
    const args = clawArgs([]);
    return typeof args?.[0] === "string" ? args[0] : "";
  } catch {
    return "";
  }
}

export function normalizePairingChannel(channel) {
  const value = String(channel || "").trim();
  return value === "wechat" ? "openclaw-weixin" : value;
}

export async function listPairingRequests({ channel, accountId, env = process.env, openclawEntry } = {}) {
  const runtime = await loadConversationRuntime(openclawEntry);
  const runtimeChannel = normalizePairingChannel(channel);
  const requests = accountId
    ? await runtime.listChannelPairingRequests(runtimeChannel, env, accountId)
    : await runtime.listChannelPairingRequests(runtimeChannel, env);
  return requests.map(normalizePairingRequest);
}

export async function approvePairingRequest({ channel, code, accountId, env = process.env, openclawEntry } = {}) {
  const runtime = await loadConversationRuntime(openclawEntry);
  const runtimeChannel = normalizePairingChannel(channel);
  const approved = await runtime.approveChannelPairingCode({
    channel: runtimeChannel,
    code: String(code || "").trim(),
    ...(accountId ? { accountId } : {}),
    env,
  });
  return approved ? normalizeApprovedPairing(approved) : null;
}

async function loadConversationRuntime(openclawEntry) {
  const modulePath = resolveConversationRuntimeModulePath(openclawEntry);
  if (!modulePath) {
    throw new Error("OpenClaw conversation runtime SDK not found");
  }
  if (cachedConversationRuntime && cachedConversationRuntimePath === modulePath) return cachedConversationRuntime;
  cachedConversationRuntime = await import(pathToFileURL(modulePath).href);
  cachedConversationRuntimePath = modulePath;
  return cachedConversationRuntime;
}

function resolveConversationRuntimeModulePath(openclawEntry) {
  const explicit = process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [];
  const cleanEntry = String(openclawEntry || process.env.OPENCLAW_ENTRY || "").trim();
  if (cleanEntry) {
    const packageRoot = path.basename(path.dirname(cleanEntry)) === "dist"
      ? path.dirname(path.dirname(cleanEntry))
      : path.dirname(cleanEntry);
    candidates.push(path.join(packageRoot, "dist", "plugin-sdk", "conversation-runtime.js"));
  }
  candidates.push("/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/conversation-runtime.js");
  candidates.push("/opt/openclaw/node_modules/openclaw/dist/plugin-sdk/conversation-runtime.js");
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function normalizePairingRequest(request) {
  const code = String(request?.code || "").trim();
  const id = String(request?.id || "").trim();
  return {
    code,
    id,
    subject_id: id || code,
    subject_name: id || code,
    meta: request?.meta && typeof request.meta === "object" ? request.meta : {},
    requested_at: String(request?.createdAt || request?.created_at || "").trim(),
  };
}

function normalizeApprovedPairing(approved) {
  return {
    id: String(approved?.id || "").trim(),
    code: String(approved?.entry?.code || "").trim(),
    entry: normalizePairingRequest(approved?.entry),
  };
}
