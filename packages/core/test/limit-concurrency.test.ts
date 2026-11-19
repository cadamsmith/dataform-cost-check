import { describe, expect, it } from "vitest";
import { limitConcurrency } from "../src/limit-concurrency.ts";
import type { DryRunResult, DryRunner } from "../src/types.ts";

/** A runner whose calls stay pending until released, recording peak concurrency. */
function gatedRunner(): { runner: DryRunner; peak: () => number; releaseAll: () => void } {
  let active = 0;
  let peak = 0;
  const pending: (() => void)[] = [];
  return {
    runner: {
      async estimate(): Promise<DryRunResult> {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
        return { bytes: 1 };
      },
    },
    peak: () => peak,
    releaseAll: () => {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("limitConcurrency", () => {
  it("never runs more than max dry runs at once and completes them all", async () => {
    const gated = gatedRunner();
    const limited = limitConcurrency(gated.runner, 2);
    const all = Promise.all(Array.from({ length: 5 }, () => limited.estimate("SELECT 1", "US")));
    for (let i = 0; i < 5; i++) {
      await tick();
      gated.releaseAll();
    }
    expect(await all).toHaveLength(5);
    expect(gated.peak()).toBe(2);
  });

  it("frees the slot when a dry run throws", async () => {
    let calls = 0;
    const limited = limitConcurrency(
      {
        estimate: () => {
          calls++;
          return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ bytes: 3 });
        },
      },
      1,
    );
    await expect(limited.estimate("a", undefined)).rejects.toThrow("boom");
    await expect(limited.estimate("b", undefined)).resolves.toEqual({ bytes: 3 });
  });

  it("rejects a non-positive limit", () => {
    expect(() => limitConcurrency(gatedRunner().runner, 0)).toThrow(RangeError);
  });
});
