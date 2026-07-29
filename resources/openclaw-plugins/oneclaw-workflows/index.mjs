import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { readJsonFileWithFallback, writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const PLUGIN_ID = 'oneclaw-workflows';
const CONTROLLER_ID = 'oneclaw/request-first';
const METHOD_SCHEMA_VERSION = 1;
const MAX_METHODS = 100;
const MAX_METHOD_VERSIONS = 20;
const MAX_METHOD_STEPS = 20;
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

function captureInteractionBrokerConfiguration() {
  const rawUrl = process.env.ONECLAW_INTERACTION_BROKER_URL;
  const token = process.env.ONECLAW_INTERACTION_BROKER_TOKEN;
  delete process.env.ONECLAW_INTERACTION_BROKER_URL;
  delete process.env.ONECLAW_INTERACTION_BROKER_TOKEN;
  if (!rawUrl || !token) return null;
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('OneClaw interaction broker must use loopback HTTP.');
  }
  return { url: url.toString().replace(/\/+$/u, ''), token };
}

const INTERACTION_BROKER_CONFIGURATION_KEY = Symbol.for(
  'oneclaw.workflows.interaction-broker-configuration',
);

function cachedInteractionBrokerConfiguration() {
  return globalThis[INTERACTION_BROKER_CONFIGURATION_KEY] ?? null;
}

function cacheInteractionBrokerConfiguration(configuration) {
  globalThis[INTERACTION_BROKER_CONFIGURATION_KEY] = configuration;
  return configuration;
}

function interactionBrokerConfiguration() {
  // OpenClaw can evaluate/register startup plugins more than once while
  // rebuilding the active tool catalog. Credentials are intentionally removed
  // from the environment after capture, so retain them in process-private
  // global state for later registrations and fresh module instances.
  if (
    process.env.ONECLAW_INTERACTION_BROKER_URL
    && process.env.ONECLAW_INTERACTION_BROKER_TOKEN
  ) {
    return cacheInteractionBrokerConfiguration(captureInteractionBrokerConfiguration());
  }
  const cached = cachedInteractionBrokerConfiguration();
  if (cached) return cached;
  return cacheInteractionBrokerConfiguration(captureInteractionBrokerConfiguration());
}

async function requestDesktopInput(configuration, toolCallId, signal) {
  if (!configuration) {
    throw new Error('OneClaw Desktop input is unavailable.');
  }
  const response = await fetch(`${configuration.url}/v1/input`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ toolCallId }),
    signal,
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'INPUT_REQUEST_FAILED');
  }
  return payload.answers;
}

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
}) {
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
    async execute(_toolCallId, args) {
      // OpenClaw 2026.7.1 instantiates tool descriptors without a session
      // context during Doctor/registry audits. Resolve the session-scoped
      // managed-flow runtime only when the model actually invokes the tool.
      const runtime = api.runtime.tasks.managedFlows.fromToolContext(context);
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
          return jsonResult({ created: true, work: flowView(work, runtime) });
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
            return jsonResult({
              ...mutationView(result, runtime),
              normalizedAction: 'wait',
            });
          }
          const result = runtime.resume({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            status: 'running',
            ...(typeof args.currentStep === 'string'
              ? { currentStep: requireText(args.currentStep, 'currentStep', 500) }
              : {}),
          });
          return jsonResult(mutationView(result, runtime));
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
          return jsonResult(mutationView(result, runtime));
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
          return jsonResult(mutationView(result, runtime));
        }
        case 'complete': {
          const result = runtime.finish({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
          });
          return jsonResult(mutationView(result, runtime));
        }
        case 'fail': {
          const note = requireText(args.note, 'note', 800);
          const result = runtime.fail({
            flowId: requireText(args.flowId, 'flowId', 200),
            expectedRevision: requireFlowRevision(args.revision),
            blockedSummary: note,
          });
          return jsonResult(mutationView(result, runtime));
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
          return jsonResult({
            started: true,
            method: selected,
            work: flowView(work, runtime),
            ...(inputNotes ? { inputNotes } : {}),
            instruction: 'Execute the method steps in order and checkpoint the returned durable work at meaningful progress points.',
          });
        }
        default:
          throw new Error(`Unsupported durable work action: ${String(args.action)}`);
      }
    },
  };
}

function createRequestUserInputTool(configuration) {
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
    async execute(toolCallId, _args, signal) {
      const answers = await requestDesktopInput(configuration, toolCallId, signal);
      return jsonResult({ answered: true, answers });
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'OneClaw Durable Work',
  description: 'Request-first durable progress and recovery for multi-step agent work.',
  register(api) {
    const interactionBroker = interactionBrokerConfiguration();
    api.registerTool(
      (context) => createWorkTool(api, context),
      { names: ['oneclaw_work'] },
    );
    api.registerTool(createRequestUserInputTool(interactionBroker), { name: 'request_user_input' });
  },
});

export const testing = {
  createWorkTool,
  createRequestUserInputTool,
  captureInteractionBrokerConfiguration,
  interactionBrokerConfiguration,
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
