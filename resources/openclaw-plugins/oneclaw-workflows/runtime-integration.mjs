import { createHash } from 'node:crypto';

const BLOCK_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const EVENT_STORE_SCHEMA_VERSION = 1;
const DEFAULT_ATTENTION_TIMEOUT_MS = 30 * 60 * 1000;
const CONTROLLER_ID = 'oneclaw/request-first';

let runtimeEventsSdkPromise;
const brokerFlushQueues = new Map();

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

export class BrokerRequestError extends Error {
  constructor(message, protocolCode = 'internal_error') {
    super(message);
    this.name = 'BrokerRequestError';
    this.protocolCode = protocolCode;
  }
}

async function brokerJson(configuration, path, { body, method = 'POST', signal } = {}) {
  if (!configuration) {
    throw new BrokerRequestError('OneClaw Desktop input is unavailable.', 'runtime_unavailable');
  }
  const response = await fetch(`${configuration.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${configuration.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new BrokerRequestError(
      typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.code === 'string'
          ? payload.code
          : 'INTERACTION_BROKER_REQUEST_FAILED',
      typeof payload?.protocolCode === 'string' ? payload.protocolCode : 'internal_error',
    );
  }
  return payload;
}

async function flushBrokerEventsNow(configuration, publisher) {
  const payload = await brokerJson(configuration, '/v1/events/pending', { method: 'GET' });
  let delivered = 0;
  let pending = 0;
  for (const item of payload.events ?? []) {
    const receipt = await publishRuntimeEvent(item.event, publisher);
    if (receipt.status !== 'accepted' && receipt.status !== 'duplicate') {
      pending += 1;
      continue;
    }
    await brokerJson(configuration, '/v1/events/ack', {
      body: { idempotencyKey: item.idempotencyKey },
    });
    delivered += 1;
  }
  return { delivered, pending };
}

export function flushBrokerEvents(configuration, publisher = defaultRuntimeEventPublish) {
  const key = configuration?.url ?? 'unconfigured';
  const previous = brokerFlushQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => flushBrokerEventsNow(configuration, publisher));
  brokerFlushQueues.set(key, current);
  void current.finally(() => {
    if (brokerFlushQueues.get(key) === current) brokerFlushQueues.delete(key);
  }).catch(() => undefined);
  return current;
}

export async function requestAttention({
  args,
  configuration,
  publisher = defaultRuntimeEventPublish,
  runId,
  sessionKey,
  signal,
  toolCallId,
}) {
  if (typeof runId !== 'string' || !runId) {
    throw new BrokerRequestError(
      'The public OneClaw runId is unavailable for this input request.',
      'run_not_active',
    );
  }
  const normalized = normalizeAttentionQuestions(args?.questions);
  const now = Date.now();
  const attentionId = attentionIdForToolCall(toolCallId);
  const created = await brokerJson(configuration, '/v1/attentions', {
    body: {
      attentionId,
      toolCallId,
      runId,
      revision: 1,
      title: boundedText(args?.title, 'Input required', 200),
      questions: normalized.questions,
      ...(sessionKey ? { sessionKey } : {}),
      createdAt: now,
      expiresAt: now + DEFAULT_ATTENTION_TIMEOUT_MS,
    },
    signal,
  });
  await flushBrokerEvents(configuration, publisher);
  if (created.attention?.status === 'resolved') {
    return {
      attentionId,
      answers: decodeAttentionAnswers(created.attention.answers, normalized.mappings),
      eventDelivery: 'delivered',
    };
  }
  if (created.attention?.status !== 'pending') {
    throw new BrokerRequestError(
      `Attention is no longer pending (${String(created.attention?.status)}).`,
      'run_not_active',
    );
  }

  const response = await brokerJson(configuration, '/v1/input', {
    body: { toolCallId },
    signal,
  });
  const delivery = await flushBrokerEvents(configuration, publisher);
  return {
    attentionId,
    answers: decodeAttentionAnswers(response.answers, normalized.mappings),
    eventDelivery: delivery.pending === 0 ? 'delivered' : 'pending',
  };
}

export function createAttentionResponder(configuration, publisher = defaultRuntimeEventPublish) {
  return {
    async respond(command) {
      const payload = command?.payload ?? {};
      const response = await brokerJson(configuration, '/v1/attentions/respond', {
        body: {
          attentionId: payload.attentionId,
          toolCallId: payload.toolCallId,
          runId: payload.runId,
          expectedRevision: payload.expectedRevision,
          answers: payload.answers,
        },
      });
      await flushBrokerEvents(configuration, publisher);
      return response.status === 'already_submitted' ? 'duplicate' : 'resolved';
    },
  };
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
