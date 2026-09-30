/** Internal adapter for existing authenticated Dashboard owner chats. Channel
 * sessions keep their durable API admission lane; this never relabels them. */
export function createOwnerHandback(rpc) {
  return async handoffId => {
    const authority = await rpc.rpcGateway('browseruse.handback-authority', { handoffId }, 5000);
    if (!authority.ok) throw new Error('No pending owner handback');
    const { sessionKey, idempotencyKey } = authority.payload || {};
    if (!/^agent:[A-Za-z0-9_-]+:dashboard:[A-Za-z0-9_-]+$/.test(sessionKey || '')
      || idempotencyKey !== `browser-handback.${handoffId}`) throw new Error('Invalid owner handback');
    const frame = await rpc.rpcGateway('chat.send', { sessionKey, idempotencyKey,
      message: '我已完成浏览器中的人工操作，请继续原任务。重新观察当前任务页面后再操作，不要重复已完成的提交。' }, 10000);
    return { accepted: frame.ok && frame.payload?.runId === idempotencyKey && ['started', 'in_flight', 'ok', 'queued'].includes(frame.payload.status) };
  };
}
