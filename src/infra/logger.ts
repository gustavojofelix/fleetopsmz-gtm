import type { Clock } from '../ports/clock.js';
import { systemClock } from '../ports/clock.js';
import { isPipelineError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are always replaced, whatever they contain. */
const SENSITIVE_KEY = /(api[_-]?key|(^|[_-])token|secret|authorization|password|cookie)$/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that adds the given fields to every line. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Receives one JSON line per log entry. Defaults to stdout. */
  write?: (line: string) => void;
  clock?: Clock;
  /** Secret values (API keys) to scrub from any string that contains them. */
  secrets?: readonly string[];
  bindings?: LogFields;
}

function scrubString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length >= 6 && result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

/** Recursively removes secrets from a value before it is serialized. */
export function redact(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (isPipelineError(value)) return redact(value.toJSON(), secrets, depth + 1);
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message, secrets) };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, secrets, depth + 1);
  }
  return output;
}

/**
 * Structured JSON logger with no dependencies. Every line carries time, level,
 * event and the bound context (run_id, agent, lead_id). Contact values should
 * not be logged by callers: log counts and IDs instead.
 */
export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const clock = options.clock ?? systemClock;
  const secrets = options.secrets ?? [];
  const bindings = options.bindings ?? {};
  const threshold = LEVEL_ORDER[options.level];

  function log(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = {
      time: clock.now().toISOString(),
      level,
      event,
      ...(redact({ ...bindings, ...fields }, secrets) as LogFields),
    };
    write(JSON.stringify(entry));
  }

  return {
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}
