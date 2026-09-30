import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createBrowserRoutes } from '../src/browser/routes.js';

test('native task thumbnails keep existing login protection and validate the conversation boundary', async t => {
  let reads = 0, views = 0;
  const browser = createBrowserRoutes({ desktop: { status: () => ({ enabled: true, ready: true }) }, credentialsConfigured: true, isAuthed: req => req.headers.authorization === 'Bearer owner', readTaskPreview: async (sessionId, after, selector) => { reads++; assert.equal(selector.toolCallId, 'call-1'); assert.equal(sessionId, 'session_1'); assert.equal(after, 1000); return { image: 'data:image/jpeg;base64,Zm9v' }; }, viewNativeTask: async sessionId => { views++; assert.equal(sessionId, 'session_1'); return { ok: true }; } });
  const app = express(); app.use('/browser', browser.router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { browser.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/browser/task-preview`;
  assert.equal((await fetch(`${base}?sessionId=session_1&after=1000`, { redirect: 'manual' })).status, 302);
  assert.equal(reads, 0);
  const headers = { Authorization: 'Bearer owner' };
  for (const query of ['sessionId=other&after=1000', 'sessionId=session_1&after=0', 'sessionId=session_1&after=abc']) assert.equal((await fetch(`${base}?${query}`, { headers })).status, 400);
  const response = await fetch(`${base}?sessionId=session_1&after=1000&toolCallId=call-1`, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).image, 'data:image/jpeg;base64,Zm9v'); assert.equal(reads, 1);
  const target = base.replace('task-preview', 'task-view');
  const init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'session_1' }) };
  assert.equal((await fetch(target, init)).status, 403); assert.equal(views, 0);
  assert.equal((await fetch(target, { ...init, headers: { ...init.headers, Origin: new URL(base).origin } })).status, 200);
  assert.equal(views, 1);
});

test('task links preserve Dashboard identity through resolve, preview, control and management', async t => {
  const calls = [], selection = {sessionKey:'agent:main:dashboard:owner',browserTaskId:'task-1'};
  const browser=createBrowserRoutes({desktop:{status:()=>({enabled:true})},credentialsConfigured:true,isAuthed:()=>true,
    viewTask:async(fields,action)=>{calls.push({fields,action});return {browser:{...selection,targetId:'page'}};},
    readTaskFrame:async fields=>{calls.push({fields});return {...selection,image:'data:image/jpeg;base64,YQ=='};},
    taskBroker:async fields=>{calls.push({fields});return {mode:'ai'};},
    requireInstanceSecretApi:(req,res,next)=>req.headers.authorization==='Bearer internal' ? next():res.sendStatus(401),
    resumeOwnerTask:async id=>{calls.push({id});return {accepted:true};}});
  const app=express();app.use('/browser',browser.router);const server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{browser.close();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=(route,body,extra={})=>fetch(base+'/browser/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  for (const route of ['task-resolve','task-view','task-manage','task-control']) {
    const body={...selection,action:'status',nativeSessionId:'session_untrusted'};
    assert.equal((await send(route,body)).status,200);
    assert.equal(calls.at(-1).fields.sessionKey,selection.sessionKey);
    assert.equal(calls.at(-1).fields.nativeSessionId,undefined);
    assert.equal((await send(route,{...body,sessionId:'session_other'})).status,400);
  }
  assert.equal((await fetch(base+'/browser/task-preview?'+new URLSearchParams(selection))).status,200);
  assert.equal(calls.at(-1).fields.sessionKey,selection.sessionKey);
  assert.equal((await send('task-resolve',{sessionKey:selection.sessionKey})).status,400);
  assert.equal((await send('internal/handback',{handoffId:'h'})).status,401);
  assert.equal((await send('internal/handback',{handoffId:'h',sessionKey:'other'},{Authorization:'Bearer internal'})).status,400);
  assert.equal((await send('internal/handback',{handoffId:'h'},{Authorization:'Bearer internal'})).status,200);
  assert.deepEqual(calls.at(-1),{id:'h'});
});
