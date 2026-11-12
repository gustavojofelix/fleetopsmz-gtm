import type { ZodType, ZodTypeDef } from 'zod';
import { PipelineError } from '../infra/errors.js';
import { sha256Hex } from '../infra/hash.js';
import type { Logger } from '../infra/logger.js';
import { DEFAULT_RETRY, withRetry } from '../infra/retry.js';
import type { RetryOptions } from '../infra/retry.js';
import type { LlmClient, LlmUsage } from '../ports/llm.js';

/** Stores validated model results so finished work is never paid for twice. */
export interface JsonCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface StructuredCallOptions<T> {
  llm: LlmClient;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  schema: ZodType<T, ZodTypeDef, unknown>;
  maxTokens: number;
  /** Part of the cache key: a changed prompt invalidates cached results. */
  promptVersion: string;
  logger: Logger;
  leadId: string;
  cache?: JsonCache | undefined;
  /** Ignore cached results and replace them. */
  force?: boolean | undefined;
  retry?: Partial<RetryOptions> | undefined;
  /** Checks beyond the schema. Any problem triggers the single repair attempt. */
  check?: (output: T) => string[];
  /**
   * When true, a reply that is schema-valid but still fails `check` after the
   * repair attempt is returned with its remaining problems instead of failing.
   */
  acceptAfterRepair?: boolean;
}

export interface StructuredCallResult<T> {
  output: T;
  /** Null when the result came from the cache. */
  usage: LlmUsage | null;
  fromCache: boolean;
  remainingProblems: string[];
}

/** Appended to the user message when the first reply was rejected. */
export function buildRepairNote(problems: readonly string[]): string {
  return [
    '',
    'Your previous reply was rejected. Fix these problems and reply again:',
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}

function schemaProblems(error: {
  issues: { path: (string | number)[]; message: string }[];
}): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * One structured model call with caching, provider retries, schema validation
 * and at most one repair attempt. Used by all three agents.
 */
export async function callStructured<T>(
  options: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  const cacheKey = sha256Hex(
    [options.promptVersion, options.model, options.schemaName, options.user].join('\u001f'),
  );

  if (options.cache !== undefined && options.force !== true) {
    const cached = options.schema.safeParse(await options.cache.get(cacheKey));
    if (cached.success) {
      const remaining = options.check?.(cached.data) ?? [];
      if (remaining.length === 0 || options.acceptAfterRepair === true) {
        return { output: cached.data, usage: null, fromCache: true, remainingProblems: remaining };
      }
    }
  }

  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0 };
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await withRetry(
      () =>
        options.llm.completeJson({
          model: options.model,
          system: options.system,
          user: attempt === 1 ? options.user : options.user + buildRepairNote(problems),
          maxTokens: options.maxTokens,
          schemaName: options.schemaName,
          jsonSchema: options.jsonSchema,
        }),
      {
        ...DEFAULT_RETRY,
        ...options.retry,
        onRetry: (info) =>
          options.logger.warn('llm.retry', {
            lead_id: options.leadId,
            attempt: info.attempt,
            delay_ms: info.delayMs,
            error: info.error,
          }),
      },
    );
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;

    const parsed = options.schema.safeParse(response.json);
    if (parsed.success) {
      problems = options.check?.(parsed.data) ?? [];
      if (problems.length === 0 || (attempt === 2 && options.acceptAfterRepair === true)) {
        await options.cache?.set(cacheKey, parsed.data);
        return { output: parsed.data, usage, fromCache: false, remainingProblems: problems };
      }
    } else {
      problems = schemaProblems(parsed.error);
    }
    options.logger.warn('model_output.rejected', {
      lead_id: options.leadId,
      schema: options.schemaName,
      attempt,
      problems,
    });
  }
  throw new PipelineError({
    code: 'model_output_invalid',
    message: 'Model output was rejected after one repair attempt',
    context: { lead_id: options.leadId, schema: options.schemaName, problems },
  });
}
