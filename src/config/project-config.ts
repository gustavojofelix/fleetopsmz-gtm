import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import { PipelineError } from '../infra/errors.js';
import { CapabilityRegistrySchema } from '../schemas/capability.js';
import type { CapabilityRegistry } from '../schemas/capability.js';
import {
  GeographyConfigSchema,
  OutreachConfigSchema,
  ScoringConfigSchema,
} from '../schemas/settings.js';
import type { GeographyConfig, OutreachConfig, ScoringConfig } from '../schemas/settings.js';

export const CONFIG_FILES = {
  capabilities: 'config/product-capabilities.json',
  scoring: 'config/scoring.json',
  geography: 'config/geography.json',
  outreach: 'config/outreach.json',
} as const;

export interface ProjectConfig {
  capabilities: CapabilityRegistry;
  scoring: ScoringConfig;
  geography: GeographyConfig;
  outreach: OutreachConfig;
}

/** Problems that stop Agent 3: drafts need a real sender to sign them. */
export function senderProblems(outreach: OutreachConfig): string[] {
  const problems: string[] = [];
  if (outreach.sender.name === null) problems.push('sender.name is not set');
  if (outreach.sender.email === null && outreach.sender.phone === null) {
    problems.push('set sender.email or sender.phone');
  }
  return problems;
}

/** Validates already-parsed JSON against a schema, with a config error on failure. */
export function parseConfig<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  data: unknown,
  label: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new PipelineError({
      code: 'config',
      message: `Invalid ${label}: ${problems.join('; ')}`,
      context: { file: label, problems },
    });
  }
  return result.data;
}

async function loadJsonConfig<T>(
  rootDir: string,
  relativePath: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(join(rootDir, relativePath), 'utf8');
  } catch (cause) {
    throw new PipelineError({
      code: 'config',
      message: `Cannot read ${relativePath}`,
      context: { file: relativePath },
      cause,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new PipelineError({
      code: 'config',
      message: `${relativePath} is not valid JSON`,
      context: { file: relativePath },
      cause,
    });
  }
  return parseConfig(schema, data, relativePath);
}

/** Loads and validates all files under config/. Fails fast on the first problem. */
export async function loadProjectConfig(rootDir: string): Promise<ProjectConfig> {
  const [capabilities, scoring, geography, outreach] = await Promise.all([
    loadJsonConfig(rootDir, CONFIG_FILES.capabilities, CapabilityRegistrySchema),
    loadJsonConfig(rootDir, CONFIG_FILES.scoring, ScoringConfigSchema),
    loadJsonConfig(rootDir, CONFIG_FILES.geography, GeographyConfigSchema),
    loadJsonConfig(rootDir, CONFIG_FILES.outreach, OutreachConfigSchema),
  ]);
  return { capabilities, scoring, geography, outreach };
}
