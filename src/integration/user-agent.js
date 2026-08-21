export const ONECLAW_USER_AGENT_ENV = "ONECLAW_USER_AGENT";
export const ONECLAW_USER_AGENT_FALLBACK = "OneClaw-Cloud/1.0";

const MAX_USER_AGENT_LENGTH = 256;

function containsHeaderControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export function sanitizeOneClawUserAgent(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_USER_AGENT_LENGTH
    || containsHeaderControlCharacter(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function buildOneClawUserAgent(version) {
  const normalizedVersion = sanitizeOneClawUserAgent(version);
  if (!normalizedVersion || /[\s/]/u.test(normalizedVersion)) {
    return ONECLAW_USER_AGENT_FALLBACK;
  }
  return `OneClaw-Cloud/${normalizedVersion}`;
}

export function resolveOneClawUserAgent(override, version) {
  return sanitizeOneClawUserAgent(override) ?? buildOneClawUserAgent(version);
}

export function withOneClawUserAgent(headers = {}, env = process.env) {
  if (Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
    return { ...headers };
  }
  return {
    ...headers,
    "User-Agent": resolveOneClawUserAgent(
      env[ONECLAW_USER_AGENT_ENV],
      env.IMAGE_VERSION,
    ),
  };
}
