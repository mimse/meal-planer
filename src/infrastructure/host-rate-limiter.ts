export type HostRateLimiterDependencies = {
  readonly minimumSpacingMs: number;
  readonly maxHosts: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type HostState = {
  tail: Promise<void>;
  releaseTail: () => void;
  nextStartMs: number;
  pending: number;
  lastUsed: number;
};

export class HostRateLimiter {
  private readonly states = new Map<string, HostState>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minimumSpacingMs: number;
  private readonly maxHosts: number;
  private sequence = 0;

  constructor(dependencies: HostRateLimiterDependencies) {
    if (!Number.isSafeInteger(dependencies.minimumSpacingMs) || dependencies.minimumSpacingMs < 0) {
      throw new Error("Rate-limit spacing must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(dependencies.maxHosts) || dependencies.maxHosts <= 0 || dependencies.maxHosts > 10_000) {
      throw new Error("Rate-limit host bound must be a positive safe integer no greater than 10000");
    }
    this.minimumSpacingMs = dependencies.minimumSpacingMs;
    this.maxHosts = dependencies.maxHosts;
    this.now = dependencies.now ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async run<T>(url: URL, operation: () => Promise<T>): Promise<T> {
    const hostname = url.hostname.toLowerCase();
    let state = this.states.get(hostname);
    if (state === undefined) {
      this.makeRoomForHost();
      let releaseTail!: () => void;
      const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
      state = { tail, releaseTail, nextStartMs: 0, pending: 0, lastUsed: ++this.sequence };
      state.releaseTail();
      this.states.set(hostname, state);
    }

    const predecessor = state.tail;
    let releaseCurrent!: () => void;
    state.tail = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    state.releaseTail = releaseCurrent;
    state.pending += 1;
    state.lastUsed = ++this.sequence;

    await predecessor;
    try {
      const delay = Math.max(0, state.nextStartMs - this.now());
      if (delay > 0) await this.sleep(delay);
      const startedAt = this.now();
      state.nextStartMs = startedAt + this.minimumSpacingMs;
      return await operation();
    } finally {
      state.pending -= 1;
      state.lastUsed = ++this.sequence;
      releaseCurrent();
    }
  }

  private makeRoomForHost(): void {
    if (this.states.size < this.maxHosts) return;
    const idle = [...this.states.entries()]
      .filter(([, state]) => state.pending === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed || left[0].localeCompare(right[0]))[0];
    if (idle === undefined) {
      throw new Error(`Rate limiter is tracking the maximum of ${this.maxHosts} active hosts`);
    }
    this.states.delete(idle[0]);
  }
}
