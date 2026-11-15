// Caps how many CLI processes run at once across all groups, so parallel
// groups do not run into the subscription's rate limit. Extra calls wait in order.
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) throw new Error('并发上限必须是正整数');
  let running = 0;
  const waiting: (() => void)[] = [];
  return async task => {
    if (running >= max) await new Promise<void>(resolve => waiting.push(resolve));
    else running++; // A waiter inherits the slot of the task that woke it.
    try { return await task(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  };
}
