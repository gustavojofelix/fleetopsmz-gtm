export interface RateLimiterOptions {
  /** Minimum time between the starts of two calls. */
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /** Runs `task` once its turn comes. Calls start in order, spaced by the interval. */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

/** Spaces out calls to an external service so its rate limit is respected. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let nextStart = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    async schedule<T>(task: () => Promise<T>): Promise<T> {
      const turn = queue.then(async () => {
        const wait = nextStart - now();
        if (wait > 0) await sleep(wait);
        nextStart = now() + options.minIntervalMs;
      });
      queue = turn;
      await turn;
      return task();
    },
  };
}
