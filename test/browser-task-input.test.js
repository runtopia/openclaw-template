import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskInputChannel, coalesceTaskInput } from '../src/public/browser-task-input.js';
const encode=value=>{const json=new TextEncoder().encode(JSON.stringify(value)),out=new Uint8Array(json.length+4);new DataView(out.buffer).setUint32(0,json.length);out.set(json,4);return out.buffer;};
test('fast task input negotiates, acknowledges one operation and never replays a lost receipt',async()=>{
  const sent=[],socket={readyState:1,bufferedAmount:0,send:bytes=>sent.push(bytes),close(){}};
  const channel=createTaskInputChannel(socket);assert.equal(channel.ready,false);channel.hello();
  assert.equal(sent.length,1);channel.receive(encode({type:'browser.task.ready',version:1}));
  const first=channel.send({token:'private',event:{type:'text',text:'中文 😀'}});
  channel.receive(encode({type:'browser.task.ack',id:1,ok:true,ackMs:4}));
  assert.equal((await first).ackMs,4);
  const second=channel.send({event:{type:'text',text:'must-not-repeat'}});
  channel.close();await assert.rejects(second,/lost/);
  assert.equal(sent.length,3);assert.equal(channel.ready,false);
  await assert.rejects(channel.send({}),/unavailable/);assert.equal(sent.length,3);
});
test('adjacent unsent text/drag/wheel coalesce while key and mouse edge order remain exact',()=>{
  assert.deepEqual(coalesceTaskInput({type:'text',text:'中'},{type:'text',text:'文😀'}),{type:'text',text:'中文😀'});
  assert.deepEqual(coalesceTaskInput({type:'scroll',x:.4,y:.4,deltaY:100},{type:'scroll',x:.5,y:.5,deltaY:200}),{type:'scroll',x:.5,y:.5,deltaY:300});
  assert.equal(coalesceTaskInput({type:'scroll',deltaY:1000},{type:'scroll',deltaY:1000}),null);
  for(const type of ['down','up','key'])assert.equal(coalesceTaskInput({type},{type}),null);
  assert.equal(coalesceTaskInput({type:'text',text:'a'},{type:'key',key:'Enter'}),null);
});
