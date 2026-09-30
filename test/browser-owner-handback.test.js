import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerHandback } from '../src/browser/owner-handback.js';

test('owner handback verifies registry authority before native chat admission and reuses one Run ID', async () => {
  const calls = [], id = 'handoff-1', sessionKey = 'agent:main:dashboard:owner';
  let receiptLost = true;
  const resume = createOwnerHandback({ rpcGateway: async (method, params) => {
    calls.push({method, params});
    if (method === 'browseruse.handback-authority') return {ok:true,payload:{sessionKey,idempotencyKey:`browser-handback.${id}`}};
    if (receiptLost) { receiptLost=false; throw new Error('lost response'); }
    return {ok:true,payload:{runId:params.idempotencyKey,status:'in_flight'}};
  }});
  await assert.rejects(resume(id), /lost response/);
  assert.deepEqual(await resume(id), {accepted:true});
  assert.equal(calls[0].method, 'browseruse.handback-authority');
  assert.deepEqual(calls[1], calls[3]);
  assert.equal(calls[1].params.sessionKey, sessionKey);
  assert.match(calls[1].params.message, /重新观察/);
});

test('rejected, Channel, or wrong-run authority never produces a successful owner continuation', async () => {
  for (const payload of [null,{sessionKey:'agent:main:oneclaw:direct:session_1',idempotencyKey:'browser-handback.h'}, {sessionKey:'agent:main:dashboard:owner',idempotencyKey:'another-run'}]) {
    let chats=0;
    const resume=createOwnerHandback({rpcGateway:async method=>{
      if(method==='chat.send')chats++;
      return {ok:Boolean(payload),payload};
    }});
    await assert.rejects(resume('h')); assert.equal(chats,0);
  }
  const resume=createOwnerHandback({rpcGateway:async method=>method==='browseruse.handback-authority'
    ? {ok:true,payload:{sessionKey:'agent:main:dashboard:owner',idempotencyKey:'browser-handback.h'}}
    : {ok:true,payload:{runId:'wrong',status:'started'}}});
  assert.deepEqual(await resume('h'),{accepted:false});
});
