/** Error categories used across the pipeline. Each maps to one handling rule. */
export type ErrorCode =
  /** Missing or invalid configuration: fail fast before processing records. */
  | 'config'
  /** A record or file failed validation: quarantine it and continue. */
  | 'input_validation'
  /** Network failure or 5xx from a provider: retry with backoff. */
  | 'provider_transient'
  /** Provider rejected the request (4xx other than 429): do not retry. */
  | 'provider_permanent'
  /** Provider rate limit (429): retry, honouring retryAfterMs when given. */
  | 'rate_limited'
  /** Model output failed schema validation: one repair attempt, then fail. */
  | 'model_output_invalid'
  /** A draft cited an unverified fact or a non-presentable capability. */
  | 'grounding_violation'
  /** Record, token or cost budget for the run was reached: stop cleanly. */
  | 'budget_exceeded'
  /** Filesystem read or write failure. */
  | 'io'
  /** A bug or an unexpected state. */
  | 'internal';

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set(['provider_transient', 'rate_limited']);

export interface PipelineErrorOptions {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  /** Suggested wait before retrying, e.g. from a Retry-After header. */
  retryAfterMs?: number;
  /** Structured details for logs. Must never contain secrets. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

/** The single error type thrown and returned across the pipeline. */
export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly context: Record<string, unknown>;

  constructor(options: PipelineErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PipelineError';
    this.code = options.code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(options.code);
    this.retryAfterMs = options.retryAfterMs;
    this.context = options.context ?? {};
  }

  /** Log-safe representation: no stack, no cause object. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retry_after_ms: this.retryAfterMs }),
      context: this.context,
      ...(this.cause instanceof Error ? { cause_message: this.cause.message } : {}),
    };
  }
}

export function isPipelineError(value: unknown): value is PipelineError {
  return value instanceof PipelineError;
}

/** Wraps anything thrown into a PipelineError so callers handle one type. */
export function toPipelineError(value: unknown, fallbackCode: ErrorCode = 'internal'): PipelineError {
  if (isPipelineError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new PipelineError({ code: fallbackCode, message, cause: value });
}
