// Optional integration only: the Wiki bridge remains responsible for evidence,
// authorization, durable queues, idempotency and review. No fields are rewritten.
export function mountLoopBackend(ctx, bridge) {
  const removers = new Set();
  let disposed = false, injection, disposal;
  const warn = () => {
    try { ctx.logger?.('dsh-llm-wiki')?.warn?.('Loop 记忆后端注册不可用；Wiki 独立记忆继续运行'); } catch {}
  };
  if (typeof ctx.inject === 'function') {
    try {
      injection = ctx.inject(['hermesLoopMemory'], child => {
        if (disposed) return;
        try {
          const registry = child.get('hermesLoopMemory');
          if (!registry) return;
          if (registry.version !== 1 || typeof registry.register !== 'function'
            || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
            warn();
            return;
          }
          child.effect(() => {
            if (disposed) return;
            const unregister = registry.register(Object.freeze({
              id: 'wiki', label: 'Wiki', version: 1,
              context: input => bridge.context(input),
              submit: input => bridge.submit(input),
              status: input => bridge.status(input),
            }));
            if (typeof unregister !== 'function') { warn(); return; }
            let active = true;
            const remove = () => {
              if (!active) return;
              active = false;
              removers.delete(remove);
              try { unregister(); } catch { warn(); }
            };
            removers.add(remove);
            return remove;
          });
        } catch { warn(); }
      });
    } catch { warn(); }
  }
  return () => {
    if (disposed) return disposal;
    disposed = true;
    for (const remove of removers) remove();
    try {
      disposal = Promise.resolve(injection?.dispose()).catch(warn);
      return disposal;
    } catch { warn(); }
  };
}
