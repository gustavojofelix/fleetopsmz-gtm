import { isPipelineError } from './errors.js';

export interface RetryInfo {
  /** The attempt that just failed, starting at 1. */
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Defaults to PipelineError.retryable; unknown errors are not retried. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: RetryInfo) => void;
  /** Injected in tests so no real time passes. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY: Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

function defaultIsRetryable(error: unknown): boolean {
  return isPipelineError(error) && error.retryable;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, honouring a provider's retry-after hint. */
export function computeDelayMs(
  attempt: number,
  error: unknown,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number,
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round(exponential * (0.5 + random() / 2));
  const hinted = isPipelineError(error) ? (error.retryAfterMs ?? 0) : 0;
  return Math.max(jittered, hinted);
}

/**
 * Runs `operation`, retrying retryable failures up to `maxAttempts` in total.
 * The last error is rethrown unchanged when attempts run out.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.maxAttempts || !isRetryable(error)) throw error;
      const delayMs = computeDelayMs(attempt, error, options, random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
