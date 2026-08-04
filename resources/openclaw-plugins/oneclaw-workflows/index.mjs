import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { readJsonFileWithFallback, writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  WorkflowEventReconciler,
  createChannelAttentionController,
} from './runtime-integration.mjs';

const PLUGIN_ID = 'oneclaw-workflows';
const CONTROLLER_ID = 'oneclaw/request-first';
const METHOD_SCHEMA_VERSION = 1;
const MAX_METHODS = 100;
const MAX_METHOD_VERSIONS = 20;
const MAX_METHOD_STEPS = 20;
const EVENT_RECONCILE_INTERVAL_MS = 30_000;
const METHOD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/iu;
const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret|cookie|authorization)\b\s*[:=]\s*["']?[^\s,"'}]{6,}/iu,
  /\bbearer\s+[a-z0-9._~+/-]{12,}/iu,
  /\bsk-[a-z0-9_-]{16,}/iu,
];
let methodMutationQueue = Promise.resolve();

const WORK_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'create',
        'list',
        'inspect',
        'advance',
        'wait',
        'resume',
        'complete',
        'fail',
        'save_method',
        'list_methods',
        'inspect_method',
        'update_method',
        'archive_method',
        'run_method',
      ],
      description: 'The durable work operation. Use advance only while continuing work; use wait when pausing for a user or external dependency.',
    },
    flowId: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'The flow id returned by create, list, or inspect.',
    },
    revision: {
      type: 'integer',
      minimum: 0,
      description: 'The latest revision returned by inspect. TaskFlows can start at revision 0; saved methods start at 1. Required for every mutation.',
    },
    goal: {
      type: 'string',
      minLength: 1,
      maxLength: 800,
      description: 'A concise, outcome-focused goal. Never include credentials or secrets.',
    },
    currentStep: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'The current human-readable step.',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: 800,
      description: 'A non-secret reason, result, blocker, or waiting detail.',
    },
    needsUser: {
      type: 'boolean',
      description: 'Required for advance and wait. For advance, false keeps work running and true safely normalizes the checkpoint to a user wait. For wait, true means the user must act or decide; false means an external dependency.',
    },
    methodId: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'The reusable work method id returned by save_method, list_methods, or inspect_method.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: 'A short user-facing name for reusable work.',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'A concise explanation of when this work method is useful.',
    },
    outcome: {
      type: 'string',
      minLength: 1,
      maxLength: 800,
      description: 'The reviewable result this method should produce.',
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_METHOD_STEPS,
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 160,
          },
          instruction: {
            type: 'string',
            minLength: 1,
            maxLength: 1200,
          },
        },
        required: ['title', 'instruction'],
        additionalProperties: false,
      },
      description: 'Meaningful, human-readable checkpoints. Never include credentials or secret values.',
    },
    inputNotes: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      description: 'Non-secret run-specific context. It is not saved into the reusable method.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const REQUEST_USER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
    },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 },
          header: { type: 'string', minLength: 1, maxLength: 80 },
          question: { type: 'string', minLength: 1, maxLength: 500 },
          options: {
            type: 'array',
            minItems: 0,
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 160 },
                description: { type: 'string', minLength: 1, maxLength: 300 },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          allowCustom: { type: 'boolean' },
          multiple: { type: 'boolean' },
        },
        required: ['id', 'header', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const REQUEST_CONNECTION_SCHEMA = {
  type: 'object',
  properties: {
    serviceId: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'Stable provider id such as gmail, google_drive, github, or slack.',
    },
    serviceName: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'User-facing provider name.',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 1_000,
      description: 'Why this task needs the connection. Never include credentials.',
    },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    authorizeLabel: { type: 'string', minLength: 1, maxLength: 160 },
    cancelLabel: { type: 'string', minLength: 1, maxLength: 160 },
  },
  required: ['serviceId', 'serviceName', 'reason'],
  additionalProperties: false,
};

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required for this durable work action.`);
  }
  return value.trim().slice(0, maxLength);
}

function requireSafeText(value, field, maxLength) {
  const text = requireText(value, field, maxLength);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`${field} appears to contain a secret. Keep credentials and tokens run-scoped.`);
  }
  return text;
}

function requireRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('revision is required. Inspect the work immediately before changing it.');
  }
  return value;
}

function requireFlowRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('revision is required. Inspect the work immediately before changing it.');
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} is required and must be true or false for this durable work action.`);
  }
  return value;
}

function requireMethodId(value) {
  const methodId = requireText(value, 'methodId', 120);
  if (!METHOD_ID_RE.test(methodId)) throw new Error('methodId is invalid.');
  return methodId;
}

function normalizeMethodSteps(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_METHOD_STEPS) {
    throw new Error(`steps must contain between 1 and ${MAX_METHOD_STEPS} meaningful checkpoints.`);
  }
  return value.map((step, index) => ({
    id: `step-${index + 1}`,
    title: requireSafeText(step?.title, `steps[${index}].title`, 160),
    instruction: requireSafeText(step?.instruction, `steps[${index}].instruction`, 1200),
  }));
}

function methodStorePath() {
  return join(resolveStateDir(), 'oneclaw', 'work-methods.json');
}

function workflowEventStorePath() {
  return join(resolveStateDir(), 'oneclaw', 'workflow-events.json');
}

async function readWorkflowEventRegistry() {
  const { value } = await readJsonFileWithFallback(
    workflowEventStorePath(),
    { schemaVersion: 1, sessions: {}, flows: {} },
  );
  return value;
}

async function writeWorkflowEventRegistry(registry) {
  await writeJsonFileAtomically(workflowEventStorePath(), registry);
}

function emptyMethodRegistry() {
  return { schemaVersion: METHOD_SCHEMA_VERSION, methods: [] };
}

function normalizeRegistry(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== METHOD_SCHEMA_VERSION) {
    return emptyMethodRegistry();
  }
  return {
    schemaVersion: METHOD_SCHEMA_VERSION,
    methods: Array.isArray(value.methods) ? value.methods.slice(0, MAX_METHODS) : [],
  };
}

async function readMethodRegistry() {
  const { value, exists } = await readJsonFileWithFallback(methodStorePath(), emptyMethodRegistry());
  if (exists && (!value || typeof value !== 'object' || value.schemaVersion !== METHOD_SCHEMA_VERSION)) {
    throw new Error('The reusable work registry is invalid or from an unsupported version.');
  }
  return normalizeRegistry(value);
}

async function mutateMethodRegistry(mutate) {
  const run = methodMutationQueue.then(async () => {
    const registry = await readMethodRegistry();
    const result = await mutate(registry);
    await writeJsonFileAtomically(methodStorePath(), registry);
    return result;
  });
  methodMutationQueue = run.catch(() => undefined);
  return run;
}

function createMethodId(name) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'method';
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

function currentMethodVersion(method) {
  return {
    revision: method.revision,
    status: method.status,
    name: method.name,
    ...(method.summary ? { summary: method.summary } : {}),
    outcome: method.outcome,
    steps: method.steps,
    createdAt: method.updatedAt,
  };
}

function methodView(method, selectedRevision = method.revision) {
  const version = method.versions.find((candidate) => candidate.revision === selectedRevision);
  if (!version) return null;
  return {
    id: method.id,
    revision: version.revision,
    status: version.status,
    name: version.name,
    ...(version.summary ? { summary: version.summary } : {}),
    outcome: version.outcome,
    steps: version.steps,
    availableRevisions: method.versions.map((candidate) => candidate.revision),
    createdAt: method.createdAt,
    updatedAt: method.updatedAt,
  };
}

function findMethod(registry, methodId) {
  return registry.methods.find((candidate) => candidate?.id === methodId);
}

function requireMethodRevision(method, expectedRevision) {
  const expected = requireRevision(expectedRevision);
  if (method.revision !== expected) {
    return {
      applied: false,
      code: 'revision_conflict',
      current: methodView(method),
      instruction: 'Inspect the latest method revision before deciding whether to retry.',
    };
  }
  return null;
}

function methodMutationView(method) {
  return { applied: true, method: methodView(method) };
}

function flowView(flow, runtime) {
  if (!flow) return null;
  return {
    id: flow.flowId,
    revision: flow.revision,
    status: flow.status,
    goal: flow.goal,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.blockedSummary ? { attention: flow.blockedSummary } : {}),
    ...(flow.cancelRequestedAt ? { cancellationRequested: true } : {}),
    taskSummary: runtime.getTaskSummary(flow.flowId) ?? {
      total: 0,
      active: 0,
      failures: 0,
    },
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt ? { endedAt: flow.endedAt } : {}),
  };
}

function mutationView(result, runtime) {
  if (result.applied) {
    return { applied: true, work: flowView(result.flow, runtime) };
  }
  return {
    applied: false,
    code: result.code,
    ...(result.current ? { current: flowView(result.current, runtime) } : {}),
    instruction: 'Inspect the latest work revision before deciding whether to retry.',
  };
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
  };
}

function createWorkTool(api, context, methodRepository = {
  read: readMethodRegistry,
  mutate: mutateMethodRegistry,
}, eventRuntime = {}) {
  return {
    name: 'oneclaw_work',
    label: 'Durable Work',
    description: 'Remember and recover meaningful multi-step work, especially work the user explicitly needs to pause, resume, or survive an app/Gateway restart. Save successful repeatable processes as versioned work methods. Do not use it for simple one-turn answers.',
    promptSnippet: 'For meaningful multi-step or repeatable work, use oneclaw_work to keep durable outcome-focused progress. When the user explicitly needs work to pause, resume later, or survive closing/restarting the app, create durable work before the first checkpoint and set it waiting before ending the turn. Save a work method when the user asks or a successful process is clearly recurring. Do not ask the user to configure technical capabilities.',
    promptGuidelines: [
      'When the user explicitly says progress must survive closing or restarting the app, or asks to pause and continue later, create durable work before doing the first checkpoint. Before ending the paused turn, inspect it and use action=wait (not advance), needsUser=true, and the latest revision.',
      'Create durable work only when the request has multiple meaningful steps, may wait for the user or an external system, or should survive a restart.',
      'Keep goals and step names understandable to a non-technical user and never store credentials, tokens, or secret values.',
      'Inspect immediately before every mutation and use the returned revision; do not retry a revision conflict blindly.',
      'Advance only at meaningful checkpoints that continue running and always pass needsUser=false. Wait with needsUser=true for the user or needsUser=false for an external dependency. Complete or fail the work when the outcome is known.',
      'Save a reusable work method only after the process has succeeded, when the user asks to remember it, or when it is clearly recurring. Do not create methods for ordinary one-off answers.',
      'Work method steps describe business checkpoints and reviewable outcomes, not provider names, tool wiring, credentials, or hidden implementation details.',
      'When running a method, create the returned durable work first, execute its steps with the best available capabilities, and checkpoint that real work until it completes or fails.',
      'Choose and configure the capabilities needed for the request yourself. Ask the user only for missing information or consequential permission.',
    ],
    parameters: WORK_SCHEMA,
    executionMode: 'sequential',
    async execute(toolCallId, args) {
      // OpenClaw 2026.7.1 instantiates tool descriptors without a session
      // context during Doctor/registry audits. Resolve the session-scoped
      // managed-flow runtime only when the model actually invokes the tool.
      const runtime = api.runtime.tasks.managedFlows.fromToolContext(context);
      const correlation = eventRuntime.correlations?.get(toolCallId);
      const sessionKey = correlation?.sessionKey ?? context.sessionKey;
      const runId = correlation?.runId;
      await eventRuntime.reconciler?.rememberInvocation(sessionKey, runId);
      const withTaskEvent = async (value, flow) => {
        if (!flow) return jsonResult(value);
        const delivery = eventRuntime.reconciler
          ? await eventRuntime.reconciler.publishFlow(flow, sessionKey, runId)
          : { eventDelivery: 'pending', reason: 'runtime_event_bridge_unavailable' };
        return jsonResult({ ...value, ...delivery });
      };
      switch (args.action) {
        case 'create': {
          const work = runtime.createManaged({
            controllerId: CONTROLLER_ID,
            goal: requireText(args.goal, 'goal', 800),
            status: 'running',
            ...(typeof args.currentStep === 'string'
              ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
              : {}),
          });
          return withTaskEvent({ created: true, work: flowView(work, runtime) }, work);
        }
        case 'list':
          return jsonResult({ work: runtime.list().map((flow) => flowView(flow, runtime)) });
        case 'inspect': {
          const work = runtime.resolve(requireText(args.flowId, 'flowId', 200));
          return jsonResult({ found: Boolean(work), work: flowView(work, runtime) });
        }
        case 'advance': {
          const needsUser = requireBoolean(args.needsUser, 'needsUser');
          // Models occasionally describe an explicit user wait correctly but
          // select `advance`. Preserve the unambiguous business intent instead
          // of leaving work falsely running until the next restart.
          if (needsUser) {
            const note = requireText(args.note, 'note', 800);
            const result = runtime.setWaiting({
              flowId: requireText(args.flowId, 'flowId', 200),
              expectedRevision: requireFlowRevision(args.revision),
              ...(typeof args.currentStep === 'string'
                ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
                : {}),
              waitJson: { kind: 'user', reason: note },
              blockedSummary: note,
            });
            return withTaskEvent(
              {
                ...mutationView(result, runtime),
                normalizedAction: 'wait',
              },
              result.applied ? result.flow : undefined,
            );
          }
          const result = runtime.resume({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            status: 'running',
            ...(typeof args.currentStep === 'string'
              ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
              : {}),
          });
          return withTaskEvent(
            mutationView(result, runtime),
            result.applied ? result.flow : undefined,
          );
        }
        case 'resume': {
          const result = runtime.resume({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            status: 'running',
            ...(typeof args.currentStep === 'string'
              ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
              : {}),
          });
          return withTaskEvent(
            mutationView(result, runtime),
            result.applied ? result.flow : undefined,
          );
        }
        case 'wait': {
          const needsUser = requireBoolean(args.needsUser, 'needsUser');
          const note = requireText(args.note, 'note', 800);
          const result = runtime.setWaiting({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            ...(typeof args.currentStep === 'string'
              ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
              : {}),
            waitJson: { kind: needsUser ? 'user' : 'external', reason: note },
            ...(needsUser ? { blockedSummary: note } : {}),
          });
          return withTaskEvent(
            mutationView(result, runtime),
            result.applied ? result.flow : undefined,
          );
        }
        case 'complete': {
          const result = runtime.finish({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
          });
          return withTaskEvent(
            mutationView(result, runtime),
            result.applied ? result.flow : undefined,
          );
        }
        case 'fail': {
          const note = requireText(args.note, 'note', 800);
          const result = runtime.fail({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            blockedSummary: note,
          });
          return withTaskEvent(
            mutationView(result, runtime),
            result.applied ? result.flow : undefined,
          );
        }
        case 'save_method': {
          const name = requireSafeText(args.name, 'name', 160);
          const summary = typeof args.summary === 'string'
            ? requireSafeText(args.summary, 'summary', 500)
            : undefined;
          const outcome = requireSafeText(args.outcome, 'outcome', 800);
          const steps = normalizeMethodSteps(args.steps);
          const method = await methodRepository.mutate(async (registry) => {
            if (registry.methods.length >= MAX_METHODS) {
              throw new Error(`Reusable work is limited to ${MAX_METHODS} methods. Archive an old method before saving another.`);
            }
            const now = Date.now();
            const created = {
              id: createMethodId(name),
              revision: 1,
              status: 'active',
              name,
              ...(summary ? { summary } : {}),
              outcome,
              steps,
              createdAt: now,
              updatedAt: now,
              versions: [],
            };
            created.versions.push(currentMethodVersion(created));
            registry.methods.push(created);
            return created;
          });
          return jsonResult({ created: true, method: methodView(method) });
        }
        case 'list_methods': {
          const registry = await methodRepository.read();
          return jsonResult({
            methods: registry.methods
              .filter((method) => method?.status === 'active')
              .map((method) => methodView(method))
              .filter(Boolean)
              .sort((left, right) => right.updatedAt - left.updatedAt),
          });
        }
        case 'inspect_method': {
          const registry = await methodRepository.read();
          const method = findMethod(registry, requireMethodId(args.methodId));
          const selectedRevision = args.revision === undefined
            ? method?.revision
            : requireRevision(args.revision);
          const view = method && selectedRevision ? methodView(method, selectedRevision) : null;
          return jsonResult({
            found: Boolean(view),
            method: view,
            ...(method && !view ? { current: methodView(method) } : {}),
          });
        }
        case 'update_method': {
          const methodId = requireMethodId(args.methodId);
          const result = await methodRepository.mutate(async (registry) => {
            const method = findMethod(registry, methodId);
            if (!method) return { applied: false, code: 'not_found' };
            const conflict = requireMethodRevision(method, args.revision);
            if (conflict) return conflict;
            const hasChange = ['name', 'summary', 'outcome', 'steps']
              .some((field) => args[field] !== undefined);
            if (!hasChange) throw new Error('update_method requires at least one changed field.');
            if (args.name !== undefined) method.name = requireSafeText(args.name, 'name', 160);
            if (args.summary !== undefined) method.summary = requireSafeText(args.summary, 'summary', 500);
            if (args.outcome !== undefined) method.outcome = requireSafeText(args.outcome, 'outcome', 800);
            if (args.steps !== undefined) method.steps = normalizeMethodSteps(args.steps);
            method.revision += 1;
            method.status = 'active';
            method.updatedAt = Date.now();
            method.versions = [...method.versions, currentMethodVersion(method)]
              .slice(-MAX_METHOD_VERSIONS);
            return methodMutationView(method);
          });
          return jsonResult(result);
        }
        case 'archive_method': {
          const methodId = requireMethodId(args.methodId);
          const result = await methodRepository.mutate(async (registry) => {
            const method = findMethod(registry, methodId);
            if (!method) return { applied: false, code: 'not_found' };
            const conflict = requireMethodRevision(method, args.revision);
            if (conflict) return conflict;
            method.revision += 1;
            method.status = 'archived';
            method.updatedAt = Date.now();
            method.versions = [...method.versions, currentMethodVersion(method)]
              .slice(-MAX_METHOD_VERSIONS);
            return methodMutationView(method);
          });
          return jsonResult(result);
        }
        case 'run_method': {
          const registry = await methodRepository.read();
          const method = findMethod(registry, requireMethodId(args.methodId));
          const methodRevision = requireRevision(args.revision);
          const selected = method ? methodView(method, methodRevision) : null;
          if (!method || !selected) {
            return jsonResult({
              started: false,
              code: 'not_found',
              ...(method ? { current: methodView(method) } : {}),
            });
          }
          if (method.status !== 'active') {
            return jsonResult({
              started: false,
              code: 'archived',
              current: methodView(method),
            });
          }
          const inputNotes = typeof args.inputNotes === 'string'
            ? requireSafeText(args.inputNotes, 'inputNotes', 1000)
            : undefined;
          const work = runtime.createManaged({
            controllerId: CONTROLLER_ID,
            goal: selected.outcome,
            status: 'running',
            currentStep: selected.steps[0].title,
          });
          return withTaskEvent(
            {
              started: true,
              method: selected,
              work: flowView(work, runtime),
              ...(inputNotes ? { inputNotes } : {}),
              instruction: 'Execute the method steps in order and checkpoint the returned durable work at meaningful progress points.',
            },
            work,
          );
        }
        default:
          throw new Error(`Unsupported durable work action: ${String(args.action)}`);
      }
    },
  };
}

function activeCorrelation(toolCallId, eventRuntime, context) {
  const correlation = eventRuntime.correlations?.get(toolCallId);
  const activeRuns = globalThis[Symbol.for('oneclaw.activeRunsBySessionKey')];
  const activeRun = activeRuns?.get(context.sessionKey)
    ?? (activeRuns?.size === 1 ? activeRuns.values().next().value : undefined);
  return {
    runId: correlation?.runId ?? context.runId ?? activeRun?.runId,
    sessionKey: correlation?.sessionKey ?? context.sessionKey ?? activeRun?.sessionKey,
  };
}

function createRequestUserInputTool(controller, eventRuntime = {}, context = {}) {
  return {
    name: 'request_user_input',
    label: 'Request User Input',
    description: 'Ask one to four concise business questions when missing information materially changes the result. The desktop renders the questions and this call waits for structured answers.',
    promptSnippet: 'Use request_user_input only when missing business context or a consequential choice materially changes the outcome. Offer useful choices and allow a custom answer when appropriate. Never ask for technical configuration, provider selection, or information you can safely discover yourself.',
    promptGuidelines: [
      'When missing business context or a consequential choice materially changes the result, you must call request_user_input and wait for its structured answer.',
      'Never imitate request_user_input with a numbered choice list in ordinary assistant text. Use the tool for the choices, then continue the same run after it returns.',
      'Do not call request_user_input for technical configuration, provider or model selection, or information you can safely discover with available tools.',
    ],
    parameters: REQUEST_USER_INPUT_SCHEMA,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal) {
      const correlation = activeCorrelation(toolCallId, eventRuntime, context);
      const result = await controller.requestInput({
        args,
        runId: correlation.runId,
        sessionKey: correlation.sessionKey,
        signal,
        toolCallId,
      });
      return jsonResult({ answered: true, ...result });
    },
  };
}

function createRequestConnectionTool(controller, eventRuntime = {}, context = {}) {
  return {
    name: 'request_connection',
    label: 'Request App Connection',
    description: 'Publish a OneClaw Channel authorization card when the current task needs an external app or account that is not connected.',
    promptSnippet: 'When Gmail, Google Drive, GitHub, Slack, or another external account is required but unavailable, call request_connection immediately. OneClaw will show a native authorization card. Never replace the card with manual OAuth instructions or a text checklist.',
    promptGuidelines: [
      'Use request_connection whenever missing external-app access blocks the requested task.',
      'Match the card title and button labels to the user language.',
      'Never claim authorization succeeded until the provider integration confirms access after the user responds.',
      'Never ask the user to paste tokens, cookies, passwords, or OAuth codes into chat.',
    ],
    parameters: REQUEST_CONNECTION_SCHEMA,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal) {
      const correlation = activeCorrelation(toolCallId, eventRuntime, context);
      const result = await controller.requestConnection({
        args,
        runId: correlation.runId,
        sessionKey: correlation.sessionKey,
        signal,
        toolCallId,
      });
      return jsonResult({
        responded: true,
        ...result,
        instruction: result.actionId?.startsWith('connect:')
          ? 'The user chose to connect the provider. Continue only after the provider integration confirms authorization.'
          : 'The user declined or postponed the connection. Do not continue with provider-dependent work.',
      });
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'OneClaw Durable Work',
  description: 'Request-first durable progress and recovery for multi-step agent work.',
  register(api) {
    const channelAttentionController = createChannelAttentionController();
    const correlations = new Map();
    const relevantTools = new Set([
      'oneclaw_work',
      'request_user_input',
      'request_connection',
    ]);
    api.on('before_tool_call', (event, context) => {
      if (!relevantTools.has(event.toolName)) return;
      const toolCallId = event.toolCallId ?? context.toolCallId;
      const runId = event.runId ?? context.runId;
      const sessionKey = context.sessionKey;
      if (!toolCallId || !runId || !sessionKey) return;
      correlations.set(toolCallId, { runId, sessionKey, updatedAt: Date.now() });
    });
    api.on('after_tool_call', (event, context) => {
      const toolCallId = event.toolCallId ?? context.toolCallId;
      if (toolCallId) correlations.delete(toolCallId);
    });

    const reconciler = new WorkflowEventReconciler({
      load: readWorkflowEventRegistry,
      save: writeWorkflowEventRegistry,
      listFlows: (sessionKey) =>
        api.runtime.tasks.managedFlows.bindSession({ sessionKey }).list(),
      logger: api.logger,
    });
    api.registerTool(
      (context) => createWorkTool(
        api,
        context,
        {
          read: readMethodRegistry,
          mutate: mutateMethodRegistry,
        },
        { correlations, reconciler },
      ),
      { names: ['oneclaw_work'] },
    );
    api.registerTool(
      (context) => createRequestUserInputTool(
        channelAttentionController,
        { correlations },
        context,
      ),
      { names: ['request_user_input'] },
    );
    api.registerTool(
      (context) => createRequestConnectionTool(
        channelAttentionController,
        { correlations },
        context,
      ),
      { names: ['request_connection'] },
    );

    let attentionLease;
    let reconcileTimer;
    api.registerService({
      id: 'oneclaw-workflow-event-reconciliation',
      async start() {
        attentionLease = api.runtime.channel.runtimeContexts.register({
          channelId: 'oneclaw',
          accountId: 'default',
          capability: 'attention-responder',
          context: {
            respond: (command) => channelAttentionController.respond(command),
          },
        });
        const reconcile = async () => {
          try {
            await reconciler.reconcile();
          } catch (error) {
            api.logger.warn?.(
              `oneclaw-workflows: event reconciliation remains pending: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        };
        await reconcile();
        reconcileTimer = setInterval(reconcile, EVENT_RECONCILE_INTERVAL_MS);
        reconcileTimer.unref?.();
      },
      stop() {
        clearInterval(reconcileTimer);
        channelAttentionController.close();
        attentionLease?.dispose();
        attentionLease = undefined;
      },
    });
  },
});

export const testing = {
  createWorkTool,
  createRequestUserInputTool,
  createRequestConnectionTool,
  createMethodId,
  currentMethodVersion,
  flowView,
  methodView,
  mutationView,
  normalizeMethodSteps,
  normalizeRegistry,
  requireMethodRevision,
  requireFlowRevision,
  requireRevision,
  requireSafeText,
  requireText,
};
