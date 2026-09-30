import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskStream} from '../src/browser/task-stream.js';

test('renderer subscription follows only exact task targets and drops late frames after a page switch',async t=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 let poll,active={browserTaskId:'task',resourceState:'live',targetId:'a',generation:'g',sessionKey:'s',previewRunId:'r'},callbacks={},removed=[],frames=[];
 globalThis.setTimeout=fn=>{poll=fn;return 1;};globalThis.clearTimeout=()=>{};
 t.after(()=>{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;});
 const subscribe=createTaskStream({rpc:{rpcGateway:async()=>({ok:true,payload:{browser:active}})},pages:{subscribe:async(target,callback)=>{callbacks[target]=callback;return ()=>removed.push(target);}}});
 const stop=await subscribe({browserTaskId:'task',sessionKey:'s'},frame=>frames.push(frame));
 const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};await flush();
 callbacks.a({image:'a',frameToken:'fa',capturedAt:10});assert.equal(frames[0].targetId,'a');
 active={...active,targetId:'b'};await poll();await flush();
 callbacks.a({image:'stale',frameToken:'old'});callbacks.b({image:'b',frameToken:'fb'});
 assert.equal(frames.length,2);assert.equal(frames[1].targetId,'b');assert.deepEqual(removed,['a']);
 active={...active,browserTaskId:'other-task'};await poll();await flush();callbacks.b({image:'unrelated'});
 assert.equal(frames.length,2);stop();assert.deepEqual(removed,['a','b']);
});
