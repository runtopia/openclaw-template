function normalizeAnswers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new Error("One to four input answers are required.");
  }
  const questionIds = new Set();
  return value.map((candidate) => {
    const record = candidate && typeof candidate === "object" ? candidate : null;
    const questionId = typeof record?.questionId === "string"
      ? record.questionId.trim()
      : "";
    if (!questionId) throw new Error("Every input answer requires a question id.");
    if (questionId.length > 80) throw new Error("Question ids are limited to 80 characters.");
    if (questionIds.has(questionId)) throw new Error("Question ids must be unique.");
    questionIds.add(questionId);

    if (!Array.isArray(record?.selected)) {
      throw new Error("Every input answer requires a selected array.");
    }
    if (record.selected.length > 12) {
      throw new Error("Selected answers are limited to 12 values.");
    }
    const selected = record.selected.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error("Selected answers must be non-empty strings.");
      }
      const normalized = entry.trim();
      if (normalized.length > 160) {
        throw new Error("Selected answers are limited to 160 characters.");
      }
      return normalized;
    });
    if (new Set(selected).size !== selected.length) {
      throw new Error("Selected answers must be unique.");
    }

    if (record?.custom !== undefined && typeof record.custom !== "string") {
      throw new Error("Custom answers must be strings.");
    }
    const custom = typeof record?.custom === "string" ? record.custom.trim() : undefined;
    if (custom && custom.length > 2000) {
      throw new Error("Custom answers are limited to 2000 characters.");
    }
    if (record?.skipped !== undefined && typeof record.skipped !== "boolean") {
      throw new Error("Skipped must be a boolean.");
    }
    const skipped = record?.skipped === true;
    if (!skipped && selected.length === 0 && !custom) {
      throw new Error("Every input answer must contain a selection, custom text, or skip state.");
    }
    if (skipped && (selected.length > 0 || custom)) {
      throw new Error("Skipped answers cannot also contain a selection or custom text.");
    }
    return {
      questionId,
      selected,
      ...(custom ? { custom } : {}),
      ...(skipped ? { skipped: true } : {}),
    };
  });
}

function normalizeOptionalSessionKey(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("sessionKey must be a non-empty string when provided.");
  }
  const sessionKey = value.trim();
  if (sessionKey.length > 512) throw new Error("sessionKey is limited to 512 characters.");
  return sessionKey;
}

function normalizeRequiredId(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > 200) throw new Error(`${label} is limited to 200 characters.`);
  return normalized;
}

const INTERACTION_ERROR_STATUS = {
  INTERACTION_NOT_FOUND: 404,
  INTERACTION_ALREADY_ANSWERED: 409,
  INTERACTION_EXPIRED: 410,
};

export function mountInteractions(router, deps) {
  const { requireInstanceSecretApi, interactionBroker } = deps;
  const requireInstanceSecret = typeof requireInstanceSecretApi === "function"
    ? requireInstanceSecretApi
    : (_req, res) => res.status(503).json({
      ok: false,
      error: "instance secret auth unavailable",
    });

  router.post(
    "/interactions/input",
    requireInstanceSecret,
    async (req, res) => {
      if (!interactionBroker || typeof interactionBroker.submit !== "function") {
        return res.status(503).json({ ok: false, error: "interaction broker unavailable" });
      }

      try {
        const payload = {
          sessionKey: normalizeOptionalSessionKey(req.body?.sessionKey),
          runId: normalizeRequiredId(req.body?.runId, "runId"),
          toolCallId: normalizeRequiredId(req.body?.toolCallId, "toolCallId"),
          answers: normalizeAnswers(req.body?.answers),
        };
        const result = typeof interactionBroker.submitWhenReady === "function"
          ? await interactionBroker.submitWhenReady(payload)
          : interactionBroker.submit(payload);
        if (result.success) {
          return res.status(200).json({ ok: true, status: result.status });
        }
        const status = INTERACTION_ERROR_STATUS[result.code] ?? 409;
        return res.status(status).json({ ok: false, error: result.code });
      } catch (error) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

export const testing = {
  normalizeAnswers,
  normalizeOptionalSessionKey,
  normalizeRequiredId,
};
