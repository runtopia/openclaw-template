// Isolated renderer benchmark: private display/profile, no Runtime credentials.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createBrowserPagePool} from '../src/browser/page-pool.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-latency-'));
const display=':109',port=18819,endpoint=`http://127.0.0.1:${port}`;
const xvfb=spawn('/usr/bin/Xvfb',[display,'-screen','0','1280x800x24','-nolisten','tcp'],{stdio:'ignore'});
const chrome=spawn('/usr/bin/chromium',[`--user-data-dir=${dir}/profile`,`--remote-debugging-port=${port}`,'--no-sandbox','--no-first-run','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','about:blank'],{env:{...process.env,DISPLAY:display},stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function cdp(url,method,params={}){return new Promise((resolve,reject)=>{
 const socket=new WebSocket(url),timer=setTimeout(()=>{socket.terminate();reject(new Error('CDP timeout'));},5000);
 socket.on('error',reject);socket.on('open',()=>socket.send(JSON.stringify({id:1,method,params})));
 socket.on('message',raw=>{const result=JSON.parse(String(raw));if(result.id===1){clearTimeout(timer);socket.close();result.error?reject(new Error(result.error.message)):resolve(result.result);}});
});}
const pool=createBrowserPagePool({rpc:{rpcGateway:async()=>({ok:true,payload:{running:true,cdpReady:true,cdpUrl:endpoint}})}});
let remove;
try{
 let info;for(let i=0;i<100;i++){try{info=await (await fetch(endpoint+'/json/version')).json();break;}catch{await sleep(100);}}
 if(!info)throw new Error('Chromium did not start');
 const targets=[];
 for(const name of ['A','B']){
  const result=await cdp(info.webSocketDebuggerUrl,'Target.createTarget',{url:'about:blank',newWindow:process.env.BROWSER_BENCH_WINDOWS==='1'});
  const list=await (await fetch(endpoint+'/json/list')).json(),target=list.find(x=>x.id===result.targetId);targets.push(target);
  await cdp(target.webSocketDebuggerUrl,'Runtime.evaluate',{expression:`document.body.innerHTML='<h1>Isolated ${name}</h1><textarea id="field" style="width:90vw;height:300px;font-size:24px"></textarea><div style="height:2000px">Scroll area</div>';document.querySelector('#field').focus();document.querySelector('#field').oninput=()=>document.body.style.backgroundColor='hsl('+document.querySelector('#field').value.length*7+',50%,80%)';`});
 }
 const a=targets[0],b=targets[1],baseline=[];
 for(let i=0;i<10;i++){
  const frame=await pool.capture(a.id,{viewer:true}),start=Date.now();
  await pool.dispatch(a.id,{type:'text',text:'a'},{protocolVersion:2,frameToken:frame.frameToken});
  await pool.capture(a.id,{viewer:true});baseline.push(Date.now()-start);
 }
 let latest,waiters=[];const stream=[];
 remove=await pool.subscribe(a.id,frame=>{latest=frame;for(const fn of [...waiters])fn(frame);});
 await sleep(300);
 const samples=Number(process.env.BROWSER_BENCH_SAMPLES || 10);
 for(let i=0;i<samples;i++){
  const frame=latest && Date.now()-latest.capturedAt<500 ? latest : await pool.capture(a.id,{viewer:true}),start=Date.now();
  const next=new Promise(resolve=>{
   let done=false;const receive=f=>{if(!done && f.capturedAt>=start){done=true;clearTimeout(timer);waiters=waiters.filter(x=>x!==receive);resolve(Date.now()-start);}};
   const timer=setTimeout(()=>{if(!done){done=true;waiters=waiters.filter(x=>x!==receive);resolve(null);}},1000);waiters.push(receive);
  });
  await pool.dispatch(a.id,{type:'text',text:'b'},{protocolVersion:2,frameToken:frame.frameToken});stream.push(await next);
 }
 const value=await cdp(a.webSocketDebuggerUrl,'Runtime.evaluate',{expression:"document.querySelector('#field').value",returnByValue:true});
 assert.equal(value.result.value,'a'.repeat(10)+'b'.repeat(samples));
 const untouched=await cdp(b.webSocketDebuggerUrl,'Runtime.evaluate',{expression:"document.querySelector('#field').value",returnByValue:true});assert.equal(untouched.result.value,'');
 const stats=values=>{const valid=values.filter(Number.isFinite).sort((a,b)=>a-b);return {samples:values.length,missing:values.length-valid.length,medianMs:valid[Math.floor(valid.length*.5)],p95Ms:valid[Math.min(valid.length-1,Math.floor(valid.length*.95))]};};
 console.log(JSON.stringify({backgroundTarget:true,separateWindows:process.env.BROWSER_BENCH_WINDOWS==='1',baseline:stats(baseline),screencast:stats(stream),inputOrdering:'PASS',otherTargetUntouched:'PASS'}));
}finally{remove?.();pool.close();chrome.kill('SIGTERM');xvfb.kill('SIGTERM');await sleep(300);await fs.rm(dir,{recursive:true,force:true});}
