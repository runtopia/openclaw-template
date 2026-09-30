import { WebSocketServer } from 'ws';

// Task media channel; input is opt-in and still requires the task authority lease.
// Legacy viewers remain read-only. Each frame is [uint32 metadata length][JSON][JPEG].
// Lease transitions remain on the authenticated task authority.
export function createTaskMedia({ readFrame, subscribeFrames, taskBroker }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const cache = new Map();
  let stopped = false;
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
  function accept(req, socket, head) {
    const query = new URL(req.url, 'http://internal').searchParams;
    const browserTaskId = query.get('browserTaskId');
    const sessionId = query.get('sessionId'), sessionKey = query.get('sessionKey');
    if (stopped || !readFrame || server.clients.size >= 16 || !/^[A-Za-z0-9_-]{1,128}$/.test(browserTaskId || '')
        || !(sessionId ? /^session_[A-Za-z0-9_-]{1,128}$/.test(sessionId) && !sessionKey : valid(sessionKey))) {
      socket.end('HTTP/1.1 400 Invalid task stream\r\nConnection: close\r\n\r\n'); return;
    }
    const fields = { browserTaskId, viewer: true, ...(sessionId ? { nativeSessionId: sessionId } : { sessionKey }) };
    const key = JSON.stringify(fields);
    server.handleUpgrade(req, socket, head, ws => {
      let timer, closed = false, failures = 0, unsubscribe, lastCastAt = 0, inputReady = false, serial = 0, inputQueue = Promise.resolve(), queued = 0;
      const stop = () => { closed = true; clearTimeout(timer); unsubscribe?.(); };
      const packet = value => { if(closed || ws.readyState!==1)return;const json=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(json.length);ws.send(Buffer.concat([header,json])); };
      const sendFrame = frame => {
        if(closed || ws.readyState!==1 || ws.bufferedAmount>256*1024)return;
        if(frame.browserTaskId!==browserTaskId || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.image || ''))throw new Error('Frame unavailable');
        const {image,...metadata}=frame,json=Buffer.from(JSON.stringify(metadata)),bytes=Buffer.from(image.slice(image.indexOf(',')+1),'base64');
        if(json.length>8192 || bytes.length>700000)throw new Error('Frame too large');
        const header=Buffer.alloc(4);header.writeUInt32BE(json.length);ws.send(Buffer.concat([header,json,bytes]));
      };
      ws.on('close', stop); ws.on('error', stop);
      ws.on('message', (data,binary) => {
        try {
          if(!binary || data.length<5 || data.length>8192 || data.readUInt32BE(0)!==data.length-4)throw new Error('Invalid packet');
          const message=JSON.parse(data.subarray(4).toString());
          if(message.type==='browser.task.hello' && message.version===1 && taskBroker){inputReady=true;packet({type:'browser.task.ready',version:1});return;}
          if(!inputReady || !taskBroker || message.type!=='browser.task.input' || !Number.isSafeInteger(message.id) || message.id!==serial+1 || queued>=8)throw new Error('Invalid input');
          serial=message.id;queued++;const started=Date.now();
          inputQueue=inputQueue.then(async()=>{
            if(closed)return;
            try {
              await taskBroker({...fields,viewer:undefined,action:'input',token:message.token,protocolVersion:2,
                expectedControlEpoch:message.expectedControlEpoch,expectedTargetId:message.expectedTargetId,generation:message.generation,
                frameToken:message.frameToken,event:message.event});
              packet({type:'browser.task.ack',id:message.id,ok:true,ackMs:Date.now()-started});
            }catch{packet({type:'browser.task.ack',id:message.id,ok:false,errorCode:'browser_task_input_failed'});}
          }).finally(()=>{queued--;});
        }catch{ws.close(1008,'Read-only or invalid task input');}
      });
      if(subscribeFrames)void Promise.resolve(subscribeFrames(fields,frame=>{
        try{sendFrame(frame);lastCastAt=Date.now();failures=0;}catch{ /* Keep the bounded screenshot fallback. */ }
      })).then(remove=>{if(closed)remove();else unsubscribe=remove;}).catch(()=>{});
      async function tick() {
        if (closed || stopped || ws.readyState !== 1) return;
        try {
          if (ws.bufferedAmount < 256 * 1024 && Date.now()-lastCastAt > 1000) {
            let sample = cache.get(key);
            if (!sample || Date.now() - sample.at >= 200) {
              sample = { at: Date.now(), promise: Promise.resolve().then(() => readFrame(fields)) };
              cache.set(key, sample);
              if (cache.size > 64) cache.delete(cache.keys().next().value);
            }
            const frame = await sample.promise;
            if (closed || ws.readyState !== 1) return;
            sendFrame(frame);
            failures = 0;
          }
        } catch {
          if (++failures >= 5) { ws.close(1013, 'Task preview unavailable'); return; }
        }
        if (!closed) timer = setTimeout(tick, 200);
      }
      void tick();
    });
  }
  return { accept, close: () => { stopped = true; for (const ws of server.clients) ws.terminate(); server.close(); cache.clear(); } };
}
