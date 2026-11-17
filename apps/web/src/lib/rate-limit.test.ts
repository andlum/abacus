import { describe, expect, it } from "vitest";
import { fixedWindow } from "./rate-limit";

describe("a fixed-window rate limit", () => {
  it("allows the limit in a window, then refuses with the seconds left until the next", () => {
    const limit = fixedWindow({ limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect([limit("a", t), limit("a", t + 1), limit("a", t + 2)]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(limit("a", t + 30_000)).toEqual({ ok: false, retryAfterSeconds: 30 });
    expect(limit("a", t + 59_999)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("counts each key on its own", () => {
    const limit = fixedWindow({ limit: 1, windowMs: 60_000 });
    expect(limit("a", 0)).toEqual({ ok: true });
    expect(limit("b", 0)).toEqual({ ok: true });
    expect(limit("a", 1).ok).toBe(false);
  });

  it("starts again in the next window", () => {
    const limit = fixedWindow({ limit: 1, windowMs: 60_000 });
    expect(limit("a", 0).ok).toBe(true);
    expect(limit("a", 10).ok).toBe(false);
    expect(limit("a", 60_000).ok).toBe(true);
  });

  it("forgets keys whose window has passed", () => {
    const limit = fixedWindow({ limit: 1, windowMs: 1_000 });
    for (let i = 0; i < 100; i++) limit(`k${i}`, 0);
    limit("z", 5_000);
    expect(limit.size()).toBe(1);
  });
});
