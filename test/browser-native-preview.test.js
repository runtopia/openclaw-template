import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createBrowserRoutes } from '../src/browser/routes.js';

test('native task thumbnails keep existing login protection and validate the conversation boundary', async t => {
  let reads = 0;
  const browser = createBrowserRoutes({ desktop: { status: () => ({ enabled: true, ready: true }) }, credentialsConfigured: true, isAuthed: req => req.headers.authorization === 'Bearer owner', readTaskPreview: async (sessionId, after) => { reads++; assert.equal(sessionId, 'session_1'); assert.equal(after, 1000); return { image: 'data:image/jpeg;base64,Zm9v' }; } });
  const app = express(); app.use('/browser', browser.router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { browser.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/browser/task-preview`;
  assert.equal((await fetch(`${base}?sessionId=session_1&after=1000`, { redirect: 'manual' })).status, 302);
  assert.equal(reads, 0);
  const headers = { Authorization: 'Bearer owner' };
  for (const query of ['sessionId=other&after=1000', 'sessionId=session_1&after=0', 'sessionId=session_1&after=abc']) assert.equal((await fetch(`${base}?${query}`, { headers })).status, 400);
  const response = await fetch(`${base}?sessionId=session_1&after=1000`, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).image, 'data:image/jpeg;base64,Zm9v'); assert.equal(reads, 1);
});
