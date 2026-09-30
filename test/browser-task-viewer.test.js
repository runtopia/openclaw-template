import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {createScopedTaskViewer} from '../src/public/browser-task.js';

test('changing tasks drops queued old input and never sends it with the next task token',async t=>{
 const originals=Object.fromEntries(['document','window','sessionStorage','fetch','Image'].map(k=>[k,globalThis[k]]));
 const elements=new Map(),events=new Map(),requests=[],messages=[];let pendingInput;
 const element=id=>{if(!elements.has(id))elements.set(id,{style:{},dataset:{},width:720,height:450,getContext:()=>({clearRect(){},drawImage(){}}),addEventListener:(name,fn)=>events.set(id+name,fn),getBoundingClientRect:()=>({left:0,top:0,width:720,height:450}),setPointerCapture(){}});return elements.get(id);};
 globalThis.document={hidden:false,querySelector:element,addEventListener(){}};globalThis.window={addEventListener(){},confirm:()=>true};
 globalThis.sessionStorage={getItem:()=>null,setItem(){},removeItem(){}};
 globalThis.Image=class{naturalWidth=720;naturalHeight=450;decode(){return Promise.resolve();}};
 const tasks=Object.fromEntries(['a','b'].map(id=>[id,{browserTaskId:'task-'+id,targetId:'tab-'+id,generation:'g',sessionKey:id,resourceState:'live',phase:'completed'}]));
 const modes={a:'ai',b:'ai'};
 globalThis.fetch=async(url,options)=>{
  const body=options?JSON.parse(options.body):null;if(body)requests.push(body);
  let result;
  if(url==='/browser/task-resolve')result={browser:tasks[body.sessionId]};
  else if(url.startsWith('/browser/task-preview')){const id=new URL(url,'http://test').searchParams.get('sessionId');result={...tasks[id],image:'data:image/jpeg;base64,YQ=='};}
  else {const id=body.sessionId;if(body.action==='input')await new Promise(resolve=>{pendingInput=resolve;});if(body.action==='request')modes[id]='human';if(body.action==='pause')modes[id]='paused';result={browser:tasks[id],mode:modes[id],mine:modes[id]!=='ai',inFlight:0,epoch:1,...(body.action==='request'?{token:id.repeat(64)}:{})};}
  return{ok:true,json:async()=>result};
 };
 const viewer=createScopedTaskViewer({postNative:m=>messages.push(m),stopDesktop(){}});
 t.after(()=>{viewer.dispose();for(const [key,value]of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const flush=async()=>{for(let i=0;i<8;i++)await setImmediate();};
 await viewer.open({sessionId:'a',toolCallId:'call-a'});await flush();await viewer.takeover();
 viewer.send({type:'down',x:.2,y:.2});viewer.send({type:'text',text:'old queued input'});await flush();
 assert.ok(pendingInput);await viewer.open({sessionId:'b',toolCallId:'call-b'});await flush();await viewer.takeover();
 pendingInput();await flush();
 assert.equal(requests.filter(r=>r.action==='input').length,1);assert.equal(requests.find(r=>r.action==='input').browserTaskId,'task-a');
 assert.equal(JSON.stringify(messages).includes('aaaaaaaa'),false);
});
