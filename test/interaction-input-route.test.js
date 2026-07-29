import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { InteractionBrokerService } from "../src/interactions/broker.js";
import { createAuth } from "../src/proxy/auth.js";
import { mountInteractions } from "../src/repair/interactions.js";

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("runtime input endpoint requires the instance secret and resolves broker input", async (t) => {
  const service = new InteractionBrokerService({
    maxWaitMs: 1_000,
    registrationGraceMs: 20,
  });
  const auth = createAuth({
    SETUP_PASSWORD: "setup-password",
    ONECLAW_INSTANCE_SECRET: "instance-secret",
    GATEWAY_TOKEN: "gateway-token",
    PORT: 8080,
  });
  const router = express.Router();
  mountInteractions(router, {
    requireInstanceSecretApi: auth.requireInstanceSecretApi,
    interactionBroker: service,
  });
  const app = express();
  app.use(express.json());
  app.use("/repair", router);
  const server = await listen(app);
  t.after(() => {
    service.close();
    server.close();
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/repair/interactions/input`;
  const body = JSON.stringify({
    sessionKey: "agent:main:main",
    runId: "run-1",
    toolCallId: "call-1",
    answers: [{ questionId: "audience", selected: ["Executives"] }],
  });

  const cookieOnly = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `ocsess=${auth.signSession()}`,
    },
    body,
  });
  assert.equal(cookieOnly.status, 401);

  const gatewayToken = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer gateway-token",
    },
    body,
  });
  assert.equal(gatewayToken.status, 401);

  const pending = service.waitForInput("call-1");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer instance-secret",
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "submitted",
  });
  assert.deepEqual(await pending, [
    { questionId: "audience", selected: ["Executives"] },
  ]);
});

test("runtime input endpoint validates structured answers", async (t) => {
  const service = new InteractionBrokerService({
    maxWaitMs: 1_000,
    registrationGraceMs: 5,
  });
  const auth = createAuth({
    SETUP_PASSWORD: "",
    ONECLAW_INSTANCE_SECRET: "instance-secret",
    GATEWAY_TOKEN: "gateway-token",
    PORT: 8080,
  });
  const router = express.Router();
  mountInteractions(router, {
    requireInstanceSecretApi: auth.requireInstanceSecretApi,
    interactionBroker: service,
  });
  const app = express();
  app.use(express.json());
  app.use("/repair", router);
  const server = await listen(app);
  t.after(() => {
    service.close();
    server.close();
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/repair/interactions/input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer instance-secret",
    },
    body: JSON.stringify({
      runId: "run-1",
      toolCallId: "call-1",
      answers: [{ questionId: "audience", selected: [] }],
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "INVALID_REQUEST");
  assert.match(payload.message, /selection, custom text, or skip state/);
});

test("runtime input endpoint locks idempotent, conflicting, missing, and expired statuses", async (t) => {
  const service = new InteractionBrokerService({
    maxWaitMs: 10,
    registrationGraceMs: 5,
    terminalTtlMs: 1_000,
  });
  const auth = createAuth({
    SETUP_PASSWORD: "",
    ONECLAW_INSTANCE_SECRET: "instance-secret",
    GATEWAY_TOKEN: "gateway-token",
    PORT: 8080,
  });
  const router = express.Router();
  mountInteractions(router, {
    requireInstanceSecretApi: auth.requireInstanceSecretApi,
    interactionBroker: service,
  });
  const app = express();
  app.use(express.json());
  app.use("/repair", router);
  const server = await listen(app);
  t.after(() => {
    service.close();
    server.close();
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/repair/interactions/input`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer instance-secret",
  };
  const request = {
    runId: "run-1",
    toolCallId: "call-idempotent",
    answers: [{ questionId: "audience", selected: ["Executives"] }],
  };

  const pending = service.waitForInput(request.toolCallId);
  const submitted = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(await submitted.json(), { ok: true, status: "submitted" });
  await pending;

  const replay = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, status: "already_submitted" });

  const conflict = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...request,
      answers: [{ questionId: "audience", selected: ["Engineers"] }],
    }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    ok: false,
    error: "INTERACTION_ALREADY_ANSWERED",
  });

  const selectedOrderRequest = {
    runId: "run-selected-order",
    toolCallId: "call-selected-order",
    answers: [
      { questionId: "audience", selected: ["Executives", "Operators"] },
    ],
  };
  const selectedOrderPending = service.waitForInput(
    selectedOrderRequest.toolCallId,
  );
  const selectedOrderSubmitted = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(selectedOrderRequest),
  });
  assert.equal(selectedOrderSubmitted.status, 200);
  await selectedOrderPending;

  const selectedOrderConflict = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...selectedOrderRequest,
      answers: [
        { questionId: "audience", selected: ["Operators", "Executives"] },
      ],
    }),
  });
  assert.equal(selectedOrderConflict.status, 409);
  assert.deepEqual(await selectedOrderConflict.json(), {
    ok: false,
    error: "INTERACTION_ALREADY_ANSWERED",
  });

  const answerOrderRequest = {
    runId: "run-answer-order",
    toolCallId: "call-answer-order",
    answers: [
      { questionId: "audience", selected: ["Executives", "Operators"] },
      { questionId: "format", selected: ["Memo"] },
    ],
  };
  const answerOrderPending = service.waitForInput(answerOrderRequest.toolCallId);
  const answerOrderSubmitted = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(answerOrderRequest),
  });
  assert.equal(answerOrderSubmitted.status, 200);
  await answerOrderPending;

  const answerOrderConflict = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...answerOrderRequest,
      answers: [
        { questionId: "format", selected: ["Memo"] },
        { questionId: "audience", selected: ["Executives", "Operators"] },
      ],
    }),
  });
  assert.equal(answerOrderConflict.status, 409);
  assert.deepEqual(await answerOrderConflict.json(), {
    ok: false,
    error: "INTERACTION_ALREADY_ANSWERED",
  });

  const missing = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, toolCallId: "call-missing" }),
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    ok: false,
    error: "INTERACTION_NOT_FOUND",
  });

  const expiredPending = service.waitForInput("call-expired");
  await assert.rejects(expiredPending, /INPUT_REQUEST_TIMED_OUT/);
  const expired = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, toolCallId: "call-expired" }),
  });
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), {
    ok: false,
    error: "INTERACTION_EXPIRED",
  });
});
