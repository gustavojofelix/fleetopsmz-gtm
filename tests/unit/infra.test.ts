import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEnvFor,
  missingVariables,
  parseEnv,
  secretValues,
} from '../../src/config/env.js';
import { PipelineError, isPipelineError, toPipelineError } from '../../src/infra/errors.js';
import { createLogger, redact } from '../../src/infra/logger.js';
import { computeDelayMs, withRetry } from '../../src/infra/retry.js';

const fixedClock = { now: () => new Date('2026-11-12T16:40:00Z') };
const noSleep = async (): Promise<void> => {};

describe('PipelineError', () => {
  it('marks transient and rate-limit errors retryable by default', () => {
    assert.equal(new PipelineError({ code: 'provider_transient', message: 'x' }).retryable, true);
    assert.equal(new PipelineError({ code: 'rate_limited', message: 'x' }).retryable, true);
    assert.equal(new PipelineError({ code: 'provider_permanent', message: 'x' }).retryable, false);
    assert.equal(new PipelineError({ code: 'model_output_invalid', message: 'x' }).retryable, false);
  });

  it('wraps unknown errors and passes PipelineErrors through', () => {
    const original = new PipelineError({ code: 'io', message: 'disk' });
    assert.equal(toPipelineError(original), original);
    const wrapped = toPipelineError(new Error('boom'));
    assert.ok(isPipelineError(wrapped));
    assert.equal(wrapped.code, 'internal');
    assert.equal(wrapped.message, 'boom');
  });

  it('serializes without a stack trace', () => {
    const json = new PipelineError({ code: 'config', message: 'bad', context: { file: 'a' } }).toJSON();
    assert.deepEqual(json, {
      name: 'PipelineError',
      code: 'config',
      message: 'bad',
      retryable: false,
      context: { file: 'a' },
    });
  });
});

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries retryable errors and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new PipelineError({ code: 'provider_transient', message: 'down' });
        return calls;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        sleep: noSleep,
        random: () => 1,
        onRetry: (info) => delays.push(info.delayMs),
      },
    );
    assert.equal(result, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('stops at maxAttempts and rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new PipelineError({ code: 'rate_limited', message: 'slow down' });
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep },
      ),
      (error: unknown) => isPipelineError(error) && error.code === 'rate_limited',
    );
    assert.equal(calls, 3);
  });

  it('does not retry non-retryable or unknown errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new PipelineError({ code: 'provider_permanent', message: 'bad request' });
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep },
      ),
    );
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('unexpected');
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep },
      ),
    );
    assert.equal(calls, 1);
  });

  it('honours a retry-after hint and caps exponential growth', () => {
    const limits = { baseDelayMs: 100, maxDelayMs: 400 };
    const hinted = new PipelineError({ code: 'rate_limited', message: 'x', retryAfterMs: 5_000 });
    assert.equal(computeDelayMs(1, hinted, limits, () => 1), 5_000);
    assert.equal(computeDelayMs(10, new Error('x'), limits, () => 1), 400);
    assert.equal(computeDelayMs(1, new Error('x'), limits, () => 0), 50);
  });
});

describe('logger', () => {
  it('writes one JSON line with time, level, event and bindings', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      write: (line) => lines.push(line),
      clock: fixedClock,
      bindings: { run_id: 'r1' },
    }).child({ agent: 'minerador' });
    logger.info('record.processed', { lead_id: 'lead_1', duration_ms: 12 });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
      time: '2026-11-12T16:40:00.000Z',
      level: 'info',
      event: 'record.processed',
      run_id: 'r1',
      agent: 'minerador',
      lead_id: 'lead_1',
      duration_ms: 12,
    });
  });

  it('drops lines below the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    assert.equal(lines.length, 2);
  });

  it('redacts sensitive field names but keeps token usage counts', () => {
    const redacted = redact({
      ANTHROPIC_API_KEY: 'sk-secret-value',
      apiKey: 'abc',
      headers: { Authorization: 'Bearer abc', accept: 'json' },
      APIFY_TOKEN: 'tok',
      usage: { input_tokens: 120, output_tokens: 45 },
    });
    assert.deepEqual(redacted, {
      ANTHROPIC_API_KEY: '[REDACTED]',
      apiKey: '[REDACTED]',
      headers: { Authorization: '[REDACTED]', accept: 'json' },
      APIFY_TOKEN: '[REDACTED]',
      usage: { input_tokens: 120, output_tokens: 45 },
    });
  });

  it('scrubs known secret values from any string, including error messages', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      write: (line) => lines.push(line),
      secrets: ['sk-very-secret-key'],
    });
    logger.error('provider.failed', {
      url: 'https://api.example.com?key=sk-very-secret-key',
      error: new Error('request with sk-very-secret-key failed'),
    });
    assert.equal(lines[0]?.includes('sk-very-secret-key'), false);
    assert.equal(lines[0]?.includes('[REDACTED]'), true);
  });
});

describe('environment configuration', () => {
  it('applies defaults and treats blank values as unset', () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: '', LOG_LEVEL: '', MAX_CONCURRENCY: '' });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(env.MAX_CONCURRENCY, 3);
    assert.equal(env.DEFAULT_BATCH_LIMIT, 5);
    assert.equal(env.SEARCH_PROVIDER, 'serper');
  });

  it('rejects invalid values with a config error that names the variable', () => {
    assert.throws(
      () => parseEnv({ MAX_CONCURRENCY: 'many' }),
      (error: unknown) =>
        isPipelineError(error) && error.code === 'config' && /MAX_CONCURRENCY/.test(error.message),
    );
  });

  it('requires only the providers an agent actually uses', () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: 'sk-test-anthropic', ANTHROPIC_MODEL: 'test-model' });
    assert.deepEqual(missingVariables(['minerador'], env), []);
    assert.deepEqual(missingVariables(['copywriter'], env), []);
    assert.deepEqual(missingVariables(['pesquisador'], env), ['SERPER_API_KEY']);
    assert.doesNotThrow(() => assertEnvFor(['minerador'], env));
    assert.throws(() => assertEnvFor(['minerador', 'pesquisador'], env));
  });

  it('requires the Tavily key instead when Tavily is the selected provider', () => {
    const env = parseEnv({ SEARCH_PROVIDER: 'tavily' });
    assert.ok(missingVariables(['pesquisador'], env).includes('TAVILY_API_KEY'));
    assert.equal(missingVariables(['pesquisador'], env).includes('SERPER_API_KEY'), false);
  });

  it('exposes secret values for log scrubbing only', () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: 'sk-test-anthropic', SERPER_API_KEY: 'serper-test' });
    assert.deepEqual(secretValues(env), ['sk-test-anthropic', 'serper-test']);
  });
});
