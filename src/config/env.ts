import { existsSync } from 'node:fs';
import { z } from 'zod';
import { PipelineError } from '../infra/errors.js';
import type { AgentName } from '../schemas/primitives.js';
import { SearchProviderNameSchema } from '../schemas/search.js';

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const optionalString = z.preprocess(blankToUndefined, z.string().min(1).optional());

export const EnvSchema = z.object({
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  SERPER_API_KEY: optionalString,
  APIFY_TOKEN: optionalString,
  TAVILY_API_KEY: optionalString,
  SEARCH_PROVIDER: z.preprocess(blankToUndefined, SearchProviderNameSchema.default('serper')),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ),
  MAX_CONCURRENCY: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(10).default(3)),
  DEFAULT_BATCH_LIMIT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(5)),
});
export type Env = z.infer<typeof EnvSchema>;

const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'SERPER_API_KEY', 'APIFY_TOKEN', 'TAVILY_API_KEY'] as const;

/** Loads a .env file into process.env if it exists. Existing variables win. */
export function loadDotEnv(path = '.env'): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

/** Validates environment variables. Error messages name variables, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new PipelineError({
      code: 'config',
      message: `Invalid environment configuration: ${problems.join('; ')}`,
      context: { variables: result.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  return result.data;
}

/** Variables each agent needs. Only providers actually used are required. */
export function requiredVariables(agents: readonly AgentName[], env: Env): string[] {
  const required = new Set<string>();
  if (agents.length > 0) {
    required.add('ANTHROPIC_API_KEY');
    required.add('ANTHROPIC_MODEL');
  }
  if (agents.includes('pesquisador')) {
    required.add(env.SEARCH_PROVIDER === 'tavily' ? 'TAVILY_API_KEY' : 'SERPER_API_KEY');
  }
  return [...required];
}

export function missingVariables(agents: readonly AgentName[], env: Env): string[] {
  const values = env as Record<string, unknown>;
  return requiredVariables(agents, env).filter((name) => values[name] === undefined);
}

/** Fails fast, before any record is processed, when a needed variable is absent. */
export function assertEnvFor(agents: readonly AgentName[], env: Env): void {
  const missing = missingVariables(agents, env);
  if (missing.length > 0) {
    throw new PipelineError({
      code: 'config',
      message: `Missing environment variables: ${missing.join(', ')}`,
      context: { missing },
    });
  }
}

/** Secret values, handed to the logger so they are scrubbed from every line. */
export function secretValues(env: Env): string[] {
  return SECRET_KEYS.map((key) => env[key]).filter((value): value is string => value !== undefined);
}
