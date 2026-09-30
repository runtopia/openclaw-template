import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { createBrowserRoutes } from '../src/browser/routes.js';

test('task media uses an authenticated read-only binary stream with exact task selection', async t => {
  const app = express(), server = http.createServer(app);
  const routes = createBrowserRoutes({
    credentialsConfigured: true, desktop: { status: () => ({ enabled: true, ready: true }) },
    isAuthed: req => req.headers.authorization === 'Bearer owner',
    readTaskFrame: async fields => {
      assert.equal(fields.nativeSessionId, 'session_1'); assert.equal(fields.browserTaskId, 'task_1');
      return { browserTaskId: 'task_1', generation: 'g1', targetId: 'page1', frameToken: 'frame1', image: 'data:image/jpeg;base64,/9j/2Q==' };
    },
  });
  app.use('/browser', routes.router); server.on('upgrade', routes.handleUpgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { routes.close(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin.replace('http:', 'ws:') + '/browser/task-stream?sessionId=session_1&browserTaskId=task_1';
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer owner', Origin: origin } });
  t.after(() => ws.terminate());
  const bytes = await new Promise((resolve, reject) => { ws.once('message', (data, binary) => { assert.equal(binary, true); resolve(data); }); ws.once('error', reject); });
  const length = bytes.readUInt32BE(0), metadata = JSON.parse(bytes.subarray(4, 4 + length).toString());
  assert.equal(metadata.browserTaskId, 'task_1'); assert.equal(metadata.frameToken, 'frame1'); assert.equal(metadata.image, undefined);
  assert.deepEqual(bytes.subarray(4 + length), Buffer.from('/9j/2Q==', 'base64'));
  const closed = new Promise(resolve => ws.once('close', code => { assert.equal(code, 1008); resolve(); }));
  ws.send('input is forbidden'); await closed;
  const unauthorized = new WebSocket(url, { headers: { Origin: origin } });
  await new Promise(resolve => unauthorized.once('error', error => { assert.match(error.message, /403/); resolve(); }));
});
