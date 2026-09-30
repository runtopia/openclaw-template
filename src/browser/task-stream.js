/** Resolve authoritative task identity independently from the physical frame
 * stream. A task switching pages never reuses another task's foreground. */
export function createTaskStream({ rpc, pages }) {
  return async (fields, emit) => {
    let stopped=false, timer, unsubscribe, key, currentTask, revision=0;
    async function refresh() {
      if(stopped)return;
      try {
        const reply=await rpc.rpcGateway('browseruse.control',{...fields,action:'status'},5000);
        const task=reply.ok && reply.payload?.browser;
        if(!task || task.browserTaskId!==fields.browserTaskId)throw new Error('No exact task');
        currentTask=task;
        const next=task.resourceState==='live' ? `${task.targetId}:${task.generation}` : '';
        if(next!==key || unsubscribe?.closed){
          key=next;const expected=++revision;unsubscribe?.();unsubscribe=null;
          if(next){
            const remove=await pages.subscribe(task.targetId, frame=>{
              if(stopped || expected!==revision)return;
              const task=currentTask;
              emit({...frame,browserTaskId:task.browserTaskId,generation:task.generation,resourceState:'live',sessionKey:task.sessionKey,
                runId:task.previewRunId || task.runId,targetId:task.targetId,displayUrl:task.displayUrl,phase:task.phase});
            });
            if(stopped || expected!==revision)remove();else unsubscribe=remove;
          }
        }
      }catch{key=undefined;revision++;unsubscribe?.();unsubscribe=null;}
      if(!stopped)timer=setTimeout(refresh,500);
    }
    void refresh();
    return ()=>{stopped=true;revision++;clearTimeout(timer);unsubscribe?.();};
  };
}
