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

test('negotiated task input stays bound to ticket identity, requires the lease and rejects duplicate sequence IDs', async t => {
  const app=express(),server=http.createServer(app),calls=[];
  const routes=createBrowserRoutes({credentialsConfigured:true,desktop:{status:()=>({enabled:true})},isAuthed:()=>true,
    readTaskFrame:async()=>({browserTaskId:'task_1',image:'data:image/jpeg;base64,/9j/2Q=='}),
    taskBroker:async fields=>{calls.push(fields);if(fields.token!=='owner-token')throw new Error('No control lease');return {ok:true};}});
  app.use('/browser',routes.router);server.on('upgrade',routes.handleUpgrade);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{routes.close();server.close();});
  const origin=`http://127.0.0.1:${server.address().port}`,url=origin.replace('http:','ws:')+'/browser/task-stream?sessionKey=agent:main:dashboard:owner&browserTaskId=task_1';
  const ws=new WebSocket(url,{headers:{Origin:origin}});t.after(()=>ws.terminate());
  await new Promise(resolve=>ws.once('open',resolve));
  const send=value=>{const data=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(data.length);ws.send(Buffer.concat([header,data]));};
  const receipt=type=>new Promise(resolve=>{const handler=data=>{if(data.readUInt32BE(0)+4===data.length){const value=JSON.parse(data.subarray(4));if(value.type===type){ws.off('message',handler);resolve(value);}}};ws.on('message',handler);});
  let reply=receipt('browser.task.ready');send({type:'browser.task.hello',version:1});await reply;
  reply=receipt('browser.task.ack');send({type:'browser.task.input',id:1,token:'not-owner',event:{type:'text',text:'denied'},sessionKey:'victim',browserTaskId:'victim'});
  assert.equal((await reply).ok,false);
  reply=receipt('browser.task.ack');send({type:'browser.task.input',id:2,token:'owner-token',event:{type:'text',text:'once'}});
  assert.equal((await reply).ok,true);
  assert.equal(calls[1].sessionKey,'agent:main:dashboard:owner');assert.equal(calls[1].browserTaskId,'task_1');
  const closed=new Promise(resolve=>ws.once('close',resolve));send({type:'browser.task.input',id:2,token:'owner-token',event:{type:'text',text:'duplicate'}});await closed;
  assert.equal(calls.length,2);
});
