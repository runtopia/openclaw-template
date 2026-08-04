import { createHash } from 'node:crypto';

const BLOCK_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const EVENT_STORE_SCHEMA_VERSION = 1;
const DEFAULT_ATTENTION_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_ATTENTION_RETENTION_MS = 60 * 60 * 1000;
const CONTROLLER_ID = 'oneclaw/request-first';

let runtimeEventsSdkPromise;

function stableDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function boundedText(value, fallback, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (normalized || fallback).slice(0, maxLength);
}

function stableBlockId(value, prefix) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (BLOCK_IDENTIFIER_RE.test(normalized)) return normalized;
  return `${prefix}_${stableDigest(normalized || prefix).slice(0, 24)}`;
}

export function attentionIdForToolCall(toolCallId) {
  return `attention_${stableDigest(toolCallId).slice(0, 32)}`;
}

export function normalizeAttentionQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    throw new Error('questions must contain between one and four items.');
  }
  const mappings = new Map();
  const normalized = questions.map((question, questionIndex) => {
    const sourceId = boundedText(question?.id, `question-${questionIndex + 1}`, 80);
    const id = stableBlockId(sourceId, 'question');
    const options = Array.isArray(question?.options)
      ? question.options.map((option, optionIndex) => {
          const optionId = stableBlockId(
            `${id}:${optionIndex}:${boundedText(option?.label, `Option ${optionIndex + 1}`, 160)}`,
            'option',
          );
          return {
            id: optionId,
            label: boundedText(option?.label, `Option ${optionIndex + 1}`, 160),
            ...(typeof option?.description === 'string' && option.description.trim()
              ? { description: option.description.trim().slice(0, 300) }
              : {}),
          };
        })
      : [];
    mappings.set(id, {
      sourceId,
      options: new Map(options.map((option) => [option.id, option.label])),
    });
    return {
      id,
      header: boundedText(question?.header, `Question ${questionIndex + 1}`, 80),
      question: boundedText(question?.question, 'Input required', 500),
      options,
      allowCustom: question?.allowCustom === true,
      multiple: question?.multiple === true,
    };
  });
  return { mappings, questions: normalized };
}

export function decodeAttentionAnswers(answers, mappings) {
  if (!Array.isArray(answers)) return [];
  return answers.map((answer) => {
    const mapping = mappings.get(answer?.questionId);
    const selectedOptionIds = Array.isArray(answer?.selectedOptionIds)
      ? answer.selectedOptionIds
      : [];
    return {
      questionId: mapping?.sourceId ?? answer?.questionId,
      selected: selectedOptionIds.map((id) => mapping?.options.get(id) ?? id),
      ...(typeof answer?.text === 'string' && answer.text
        ? { custom: answer.text }
        : {}),
    };
  });
}

function channelAttentionEvent(entry, type, now) {
  return {
    type,
    producer: 'oneclaw-workflows',
    runId: entry.runId,
    resourceId: entry.attentionId,
    revision: entry.revision,
    toolCallId: entry.toolCallId,
    occurredAt: now,
    payload: {
      kind: entry.kind,
      status: entry.status,
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      ...(entry.questions ? { questions: entry.questions } : {}),
      ...(entry.actions ? { actions: entry.actions } : {}),
      createdAt: entry.createdAt,
      updatedAt: now,
      expiresAt: entry.expiresAt,
      ...(entry.response
        ? {
            resolution: {
              ...entry.response,
              answeredAt: now,
            },
          }
        : {}),
    },
  };
}

export function createChannelAttentionController({
  publisher = defaultRuntimeEventPublish,
  now = Date.now,
} = {}) {
  const entries = new Map();

  const retainTerminal = (entry) => {
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      if (entries.get(entry.attentionId) === entry) entries.delete(entry.attentionId);
    }, TERMINAL_ATTENTION_RETENTION_MS);
    entry.timeout.unref?.();
  };

  const transition = async (entry, status, type, response) => {
    if (entry.status !== 'pending') return false;
    entry.status = status;
    entry.revision += 1;
    entry.response = response;
    const timestamp = now();
    await publishRuntimeEvent(channelAttentionEvent(entry, type, timestamp), publisher);
    retainTerminal(entry);
    return true;
  };

  const startRequest = async ({ entry, signal, timeoutError, cancelError }) => {
    entries.set(entry.attentionId, entry);
    entry.timeout = setTimeout(async () => {
      if (!await transition(entry, 'expired', 'attention.expired')) return;
      entry.reject(new Error(timeoutError));
    }, DEFAULT_ATTENTION_TIMEOUT_MS);
    entry.timeout.unref?.();
    if (signal) {
      signal.addEventListener('abort', () => {
        void transition(entry, 'cancelled', 'attention.cancelled')
          .finally(() => entry.reject(new Error(cancelError)));
      }, { once: true });
    }
    const delivery = await publishRuntimeEvent(
      channelAttentionEvent(entry, 'attention.created', entry.createdAt),
      publisher,
    );
    entry.eventDelivery = delivery.status === 'accepted' || delivery.status === 'duplicate'
      ? 'delivered'
      : 'pending';
    return entry.promise;
  };

  const createPromiseFields = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const requireCorrelation = ({ runId, sessionKey }, requestName) => {
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new Error(`The public OneClaw runId is unavailable for this ${requestName}.`);
    }
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
      throw new Error(`The OneClaw session is unavailable for this ${requestName}.`);
    }
  };

  const sameResponse = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  return {
    handles(command) {
      return entries.has(command?.payload?.attentionId);
    },

    async requestInput({ args, runId, sessionKey, signal, toolCallId }) {
      requireCorrelation({ runId, sessionKey }, 'input request');
      const attentionId = attentionIdForToolCall(toolCallId);
      const existing = entries.get(attentionId);
      if (existing) return existing.promise;
      const normalized = normalizeAttentionQuestions(args?.questions);
      const createdAt = now();
      const entry = {
        attentionId,
        toolCallId,
        runId: runId.trim(),
        sessionKey: sessionKey.trim(),
        revision: 1,
        kind: 'business_input',
        status: 'pending',
        title: boundedText(args?.title, 'Input required', 200),
        questions: normalized.questions,
        mappings: normalized.mappings,
        createdAt,
        expiresAt: createdAt + DEFAULT_ATTENTION_TIMEOUT_MS,
        response: undefined,
        ...createPromiseFields(),
        timeout: undefined,
      };
      return startRequest({
        entry,
        signal,
        timeoutError: 'INPUT_REQUEST_TIMED_OUT',
        cancelError: 'INPUT_REQUEST_CANCELLED',
      });
    },

    async requestConnection({
      args,
      runId,
      sessionKey,
      signal,
      toolCallId,
    }) {
      requireCorrelation({ runId, sessionKey }, 'connection request');
      const serviceName = boundedText(args?.serviceName, 'external app', 120);
      const serviceId = stableBlockId(args?.serviceId ?? serviceName, 'service');
      const attentionId = attentionIdForToolCall(toolCallId);
      const existing = entries.get(attentionId);
      if (existing) return existing.promise;
      const createdAt = now();
      const expiresAt = createdAt + DEFAULT_ATTENTION_TIMEOUT_MS;
      const actions = [
        {
          id: stableBlockId(`connect-${serviceId}`, 'connect'),
          label: boundedText(args?.authorizeLabel, `Connect ${serviceName}`, 160),
          style: 'primary',
          command: {
            type: 'attention.respond',
            attentionId,
            actionId: stableBlockId(`connect:${serviceId}`, 'connect'),
          },
        },
        {
          id: stableBlockId(`cancel-${serviceId}`, 'cancel'),
          label: boundedText(args?.cancelLabel, 'Not now', 160),
          style: 'secondary',
          command: {
            type: 'attention.respond',
            attentionId,
            actionId: stableBlockId(`cancel:${serviceId}`, 'cancel'),
          },
        },
      ];
      const entry = {
        attentionId,
        toolCallId,
        runId: runId.trim(),
        sessionKey: sessionKey.trim(),
        revision: 1,
        kind: 'connection',
        status: 'pending',
        title: boundedText(args?.title, `Connect ${serviceName}`, 200),
        body: boundedText(
          args?.reason,
          `OneClaw needs access to ${serviceName} to continue this request.`,
          1_000,
        ),
        actions,
        allowedActionIds: new Set(actions.map((action) => action.command.actionId)),
        createdAt,
        expiresAt,
        response: undefined,
        ...createPromiseFields(),
        timeout: undefined,
      };
      return startRequest({
        entry,
        signal,
        timeoutError: 'CONNECTION_REQUEST_TIMED_OUT',
        cancelError: 'CONNECTION_REQUEST_CANCELLED',
      });
    },

    async respond(command) {
      const payload = command?.payload ?? {};
      const entry = entries.get(payload.attentionId);
      if (!entry) throw new Error('OneClaw Attention is no longer active.');
      if (entry.runId !== payload.runId || entry.toolCallId !== payload.toolCallId) {
        throw new Error('OneClaw Attention ownership mismatch.');
      }
      if (entry.status === 'resolved') {
        const response = entry.kind === 'business_input'
          ? { answers: payload.answers }
          : { actionId: payload.actionId };
        return sameResponse(entry.response, response) ? 'duplicate' : Promise.reject(
          new Error('OneClaw Attention already resolved with another action.'),
        );
      }
      if (entry.status !== 'pending') {
        throw new Error('OneClaw Attention is no longer pending.');
      }
      if (payload.expectedRevision !== entry.revision) {
        throw new Error('OneClaw Attention revision conflict.');
      }
      let response;
      let result;
      if (entry.kind === 'business_input') {
        if (!Array.isArray(payload.answers)) {
          throw new Error('OneClaw Attention answers are required.');
        }
        const questionIds = new Set(entry.questions.map((question) => question.id));
        if (payload.answers.some((answer) => !questionIds.has(answer?.questionId))) {
          throw new Error('OneClaw Attention answer references an unknown question.');
        }
        response = { answers: payload.answers };
        result = {
          attentionId: entry.attentionId,
          answers: decodeAttentionAnswers(payload.answers, entry.mappings),
          eventDelivery: entry.eventDelivery,
        };
      } else {
        if (!entry.allowedActionIds.has(payload.actionId)) {
          throw new Error('OneClaw Attention action is invalid.');
        }
        response = { actionId: payload.actionId };
        result = {
          attentionId: entry.attentionId,
          actionId: payload.actionId,
          eventDelivery: entry.eventDelivery,
        };
      }
      await transition(entry, 'resolved', 'attention.resolved', response);
      entry.resolve(result);
      return 'resolved';
    },

    close() {
      for (const entry of entries.values()) {
        clearTimeout(entry.timeout);
        if (entry.status === 'pending') {
          entry.reject(new Error('CHANNEL_ATTENTION_CONTROLLER_STOPPED'));
        }
      }
      entries.clear();
    },
  };
}

async function defaultRuntimeEventPublish(event) {
  runtimeEventsSdkPromise ??= import('@oneclaw/runtime-events');
  const sdk = await runtimeEventsSdkPromise;
  return sdk.publish(event);
}

export async function publishRuntimeEvent(event, publisher = defaultRuntimeEventPublish) {
  try {
    return await publisher(event);
  } catch (error) {
    return {
      status: 'pending',
      idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

function emptyEventRegistry() {
  return {
    schemaVersion: EVENT_STORE_SCHEMA_VERSION,
    sessions: {},
    flows: {},
  };
}

function normalizeEventRegistry(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== EVENT_STORE_SCHEMA_VERSION) {
    return emptyEventRegistry();
  }
  return {
    schemaVersion: EVENT_STORE_SCHEMA_VERSION,
    sessions: value.sessions && typeof value.sessions === 'object' ? value.sessions : {},
    flows: value.flows && typeof value.flows === 'object' ? value.flows : {},
  };
}

function taskPhase(flow) {
  switch (flow.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting':
      return flow.blockedSummary ? 'waiting_input' : 'paused';
    default:
      return 'running';
  }
}

function taskStepStatus(phase) {
  switch (phase) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting_input':
    case 'paused':
      return 'waiting';
    default:
      return 'running';
  }
}

export function taskSnapshotEvent(flow, runId) {
  const phase = taskPhase(flow);
  const stepTitle = boundedText(flow.currentStep, flow.goal, 200);
  const terminalAt = Number.isSafeInteger(flow.endedAt) ? flow.endedAt : flow.updatedAt;
  return {
    type: 'task.snapshot',
    producer: 'workflow',
    runId,
    resourceId: flow.flowId,
    revision: flow.revision + 1,
    occurredAt: flow.updatedAt,
    payload: {
      title: boundedText(flow.goal, 'Durable work', 200),
      phase,
      currentStepId: 'current',
      steps: [{
        id: 'current',
        title: stepTitle,
        status: taskStepStatus(phase),
        ...(flow.blockedSummary
          ? { detail: boundedText(flow.blockedSummary, 'Waiting', 4_000) }
          : {}),
        ...(Number.isSafeInteger(flow.createdAt) ? { startedAt: flow.createdAt } : {}),
        ...(phase === 'completed' || phase === 'failed' || phase === 'cancelled'
          ? { completedAt: terminalAt }
          : {}),
      }],
      ...(flow.blockedSummary
        ? { attentionSummary: boundedText(flow.blockedSummary, 'Waiting', 1_000) }
        : {}),
      updatedAt: flow.updatedAt,
    },
  };
}

export class WorkflowEventReconciler {
  constructor({
    load,
    save,
    listFlows,
    publish = defaultRuntimeEventPublish,
    logger,
  }) {
    this.load = load;
    this.save = save;
    this.listFlows = listFlows;
    this.publish = publish;
    this.logger = logger;
    this.mutationQueue = Promise.resolve();
  }

  async mutate(mutation) {
    const run = this.mutationQueue.then(async () => {
      const registry = normalizeEventRegistry(await this.load());
      const result = await mutation(registry);
      await this.save(registry);
      return result;
    });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  async rememberInvocation(sessionKey, runId) {
    if (typeof sessionKey !== 'string' || !sessionKey || typeof runId !== 'string' || !runId) {
      return false;
    }
    await this.mutate((registry) => {
      registry.sessions[sessionKey] = { runId, updatedAt: Date.now() };
    });
    return true;
  }

  async publishFlow(flow, sessionKey, runId) {
    if (!flow || flow.controllerId !== CONTROLLER_ID) {
      return { eventDelivery: 'pending', reason: 'flow_not_owned' };
    }
    if (typeof runId !== 'string' || !runId) {
      await this.mutate((registry) => {
        registry.flows[flow.flowId] = {
          sessionKey,
          flowRevision: flow.revision,
          status: 'pending',
          reason: 'run_id_unavailable',
          updatedAt: Date.now(),
        };
      });
      return { eventDelivery: 'pending', reason: 'run_id_unavailable' };
    }

    const proposedEvent = taskSnapshotEvent(flow, runId);
    const existing = await this.mutate((registry) => {
      const current = registry.flows[flow.flowId];
      if (current?.flowRevision === flow.revision && current?.event) {
        return current;
      }
      const next = {
        sessionKey,
        flowRevision: flow.revision,
        event: proposedEvent,
        status: 'pending',
        updatedAt: Date.now(),
      };
      registry.flows[flow.flowId] = next;
      return next;
    });
    if (existing.status === 'delivered') {
      return { eventDelivery: 'delivered', receipt: existing.receipt };
    }

    const event = existing.event;
    const receipt = await publishRuntimeEvent(event, this.publish);
    const delivered = receipt.status === 'accepted' || receipt.status === 'duplicate';
    await this.mutate((registry) => {
      const current = registry.flows[flow.flowId];
      if (
        current?.flowRevision !== flow.revision
        || current?.event?.runId !== event.runId
      ) {
        return;
      }
      current.status = delivered ? 'delivered' : 'pending';
      current.receipt = receipt;
      current.updatedAt = Date.now();
    });
    return {
      eventDelivery: delivered ? 'delivered' : 'pending',
      receipt,
    };
  }

  async reconcile() {
    const registry = normalizeEventRegistry(await this.load());
    let delivered = 0;
    let pending = 0;
    for (const [sessionKey, session] of Object.entries(registry.sessions)) {
      if (typeof session?.runId !== 'string' || !session.runId) continue;
      let flows;
      try {
        flows = await this.listFlows(sessionKey);
      } catch (error) {
        pending += 1;
        this.logger?.warn?.(
          `oneclaw-workflows: unable to scan session ${sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      for (const flow of flows) {
        if (flow?.controllerId !== CONTROLLER_ID) continue;
        const result = await this.publishFlow(flow, sessionKey, session.runId);
        if (result.eventDelivery === 'delivered') delivered += 1;
        else pending += 1;
      }
    }
    return { delivered, pending };
  }
}

export const testing = {
  BLOCK_IDENTIFIER_RE,
  CONTROLLER_ID,
  emptyEventRegistry,
  normalizeEventRegistry,
  stableBlockId,
  taskPhase,
  taskStepStatus,
};
