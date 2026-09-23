#!/usr/bin/env node
// Run only in the dedicated Browser Use development container.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createGatewayRpc } from '../src/gateway/rpc.js';
const base = 'http://127.0.0.1:8080';
const headers = { Authorization: `Bearer ${process.env.ONECLAW_INSTANCE_SECRET}`, Origin: base };
const rpc = createGatewayRpc({ gatewayHost: '127.0.0.1', gatewayPort: 18789, gatewayToken: fs.readFileSync(`${process.env.OPENCLAW_STATE_DIR}/gateway.token`, 'utf8').trim() });
const call = async (action, extra = {}) => {
  const frame = await rpc.rpcGateway('browseruse.control', { action, ...extra });
  if (!frame.ok) throw new Error(frame.error?.message);
  return frame.payload;
};
let token;
const callId = crypto.randomUUID();
const request = async (path, method = 'GET') => {
  const response = await fetch(base + '/browser/' + path, { method, headers: { ...headers, ...(token ? { 'X-Browser-Controller': token } : {}) } });
  return { status: response.status, data: await response.json() };
};
rpc.start();
try {
  await rpc.waitUntilConnected(30000);
  if ((await call('status')).mode === 'paused') assert.equal((await request('control/recover', 'POST')).status, 200);
  assert.equal((await call('status')).mode, 'ai');
  await call('admin-begin', { callId });
  const takeover = await request('control/request', 'POST');
  assert.equal(takeover.status, 200); token = takeover.data.token;
  assert.equal(takeover.data.mode, 'waiting');
  assert.equal((await request('control/request', 'POST')).status, 409);
  await call('admin-end', { callId });
  const granted = await request('control/status');
  assert.equal(granted.data.mode, 'human');
  assert.equal(granted.data.mine, true);
  assert.notEqual((await request('start', 'POST')).status, 200);
  const unauthorized = await fetch(base + '/browser/control/release', { method: 'POST', headers });
  assert.equal(unauthorized.status, 409);
  const released = await request('control/release', 'POST');
  assert.equal(released.status, 200);
  assert.equal(released.data.mode, 'ai');
  assert.ok(released.data.epoch > 0);
  console.log('PASS: drain, exclusive owner, managed-start exclusion, ownership check, input shutdown, handback');
} finally {
  await call('admin-end', { callId }).catch(() => {});
  if (token && (await call('status').catch(() => ({}))).mode !== 'ai') await request('control/release', 'POST').catch(() => {});
  rpc.close();
}
