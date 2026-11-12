/** Time source. Injected so tests and idempotency checks are deterministic. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
