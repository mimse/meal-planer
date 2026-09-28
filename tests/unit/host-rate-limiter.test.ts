import { describe, expect, test } from "bun:test";
import { HostRateLimiter } from "../../src/infrastructure/host-rate-limiter";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("HostRateLimiter", () => {
  test("serializes same-host requests and preserves minimum start spacing", async () => {
    let now = 0;
    const starts: number[] = [];
    const firstMayFinish = deferred();
    const limiter = new HostRateLimiter({
      minimumSpacingMs: 100,
      maxHosts: 10,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    const first = limiter.run(new URL("https://recipes.example/one"), async () => {
      starts.push(now);
      await firstMayFinish.promise;
      return "one";
    });
    const second = limiter.run(new URL("https://recipes.example/two"), async () => {
      starts.push(now);
      return "two";
    });

    await Promise.resolve();
    expect(starts).toEqual([0]);
    firstMayFinish.resolve();
    expect(await Promise.all([first, second])).toEqual(["one", "two"]);
    expect(starts).toEqual([0, 100]);
  });

  test("preserves same-host spacing after a failed request", async () => {
    let now = 0;
    const starts: number[] = [];
    const limiter = new HostRateLimiter({
      minimumSpacingMs: 50,
      maxHosts: 2,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    const failed = limiter.run(new URL("https://recipes.example/fail"), async () => {
      starts.push(now);
      throw new Error("network failed");
    });
    const succeeded = limiter.run(new URL("https://recipes.example/next"), async () => {
      starts.push(now);
      return "ok";
    });

    await expect(failed).rejects.toThrow("network failed");
    expect(await succeeded).toBe("ok");
    expect(starts).toEqual([0, 50]);
  });

  test("does not serialize requests for different hosts", async () => {
    const blocker = deferred();
    const starts: string[] = [];
    const limiter = new HostRateLimiter({ minimumSpacingMs: 100, maxHosts: 2 });
    const first = limiter.run(new URL("https://one.example/a"), async () => {
      starts.push("one");
      await blocker.promise;
    });
    const second = limiter.run(new URL("https://two.example/b"), async () => {
      starts.push("two");
    });

    await second;
    expect(starts).toEqual(["one", "two"]);
    blocker.resolve();
    await first;
  });

  test("rejects a new host when all bounded host slots are active", async () => {
    const blocker = deferred();
    const limiter = new HostRateLimiter({ minimumSpacingMs: 0, maxHosts: 1 });
    const active = limiter.run(new URL("https://one.example/a"), () => blocker.promise);
    await Promise.resolve();

    await expect(limiter.run(new URL("https://two.example/b"), async () => {}))
      .rejects.toThrow("maximum of 1 active hosts");
    blocker.resolve();
    await active;
  });
});
