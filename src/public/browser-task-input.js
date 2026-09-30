/** Optional binary input lane on the exact task's existing media socket.
 * A lost acknowledgement is never retried through the fallback transport. */
export function createTaskInputChannel(socket) {
  let ready=false,closed=false,serial=0;
  const pending=new Map();
  const packet=value=>{
    const bytes=new TextEncoder().encode(JSON.stringify(value));
    if(bytes.length>8188)throw new Error('Input packet too large');
    const output=new Uint8Array(4+bytes.length);new DataView(output.buffer).setUint32(0,bytes.length);output.set(bytes,4);
    socket.send(output);
  };
  const close=()=>{
    if(closed)return;closed=true;ready=false;
    for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('Input acknowledgement lost; inspect before continuing'));}
    pending.clear();
  };
  return {
    get ready(){return ready && !closed && socket.readyState===1;},
    hello(){if(!closed && socket.readyState===1)packet({type:'browser.task.hello',version:1});},
    receive(data){
      if(!(data instanceof ArrayBuffer) || data.byteLength<5)return false;
      const length=new DataView(data).getUint32(0);
      if(length>8188 || length+4!==data.byteLength)return false; // JPEG frame, not a receipt.
      const message=JSON.parse(new TextDecoder().decode(new Uint8Array(data,4,length)));
      if(message.type==='browser.task.ready' && message.version===1){ready=true;return true;}
      if(message.type!=='browser.task.ack')throw new Error('Invalid task receipt');
      const call=pending.get(message.id);if(!call)return true;
      pending.delete(message.id);clearTimeout(call.timer);
      if(message.ok===true)call.resolve({ok:true,ackMs:message.ackMs,roundTripMs:Date.now()-call.started});else call.reject(new Error('Task authority refused input'));
      return true;
    },
    send(fields){
      if(!ready || closed || socket.readyState!==1 || socket.bufferedAmount>32768)return Promise.reject(new Error('Task input unavailable'));
      const id=++serial;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{close();socket.close();},10000);
        pending.set(id,{resolve,reject,timer,started:Date.now()});
        try{packet({...fields,type:'browser.task.input',id});}catch(error){close();reject(error);}
      });
    },
    close,
  };
}

/** Coalesce only unsent adjacent input, preserving click/key/navigation order. */
export function coalesceTaskInput(previous, next) {
  if(previous.type!==next.type)return null;
  if(next.type==='text' && previous.text.length+next.text.length<=1024)return {...previous,text:previous.text+next.text};
  if(next.type==='move' && previous.buttons===next.buttons)return next;
  if(next.type==='scroll' && Math.abs(previous.deltaY+next.deltaY)<=1200)return {...next,deltaY:previous.deltaY+next.deltaY};
  return null;
}
