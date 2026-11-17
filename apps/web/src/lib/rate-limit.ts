// A fixed-window rate limit: at most `limit` calls per key in each window of
// `windowMs`. The counts live in this process's memory, so each server
// process counts on its own and a restart clears them. That is enough to
// stop a runaway agent; it is not a quota.
export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export function fixedWindow({ limit, windowMs }: { limit: number; windowMs: number }) {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;

  const check = (key: string, now: number = Date.now()): RateDecision => {
    // Drop finished windows now and then, so the map does not grow forever.
    if (now - lastSweep >= windowMs) {
      for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      lastSweep = now;
    }
    const w = windows.get(key);
    if (!w || now - w.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (w.count < limit) {
      w.count++;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.ceil((w.start + windowMs - now) / 1000) };
  };
  check.size = () => windows.size;
  return check;
}
