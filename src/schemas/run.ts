import { z } from 'zod';
import { AgentNameSchema, IsoDateTimeSchema, RunIdSchema } from './primitives.js';

export const StageStatusSchema = z.enum(['pending', 'ok', 'skipped', 'failed']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

/** State of one lead at one agent stage within a run. */
export const StageStateSchema = z
  .object({
    status: StageStatusSchema,
    /** Hash of input, prompt version and model. A match means the work is done. */
    idempotency_key: z.string().min(1).nullable(),
    attempts: z.number().int().min(0),
    error_code: z.string().min(1).nullable(),
    updated_at: IsoDateTimeSchema,
  })
  .strict();
export type StageState = z.infer<typeof StageStateSchema>;

/**
 * manifest.json of a run folder. It is what makes a run resumable: only stages
 * that are not "ok" or "skipped" are processed again.
 */
export const RunManifestSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: RunIdSchema,
    status: z.enum(['running', 'completed', 'failed', 'interrupted']),
    agents: z.array(AgentNameSchema).min(1),
    started_at: IsoDateTimeSchema,
    finished_at: IsoDateTimeSchema.nullable(),
    input_files: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          rows: z.number().int().min(0),
        })
        .strict(),
    ),
    model: z.string().min(1).nullable(),
    prompt_versions: z.record(AgentNameSchema, z.string().min(1)),
    /** lead_id (or raw_id before identity resolution) to per-agent stage state. */
    records: z.record(z.string().min(1), z.record(AgentNameSchema, StageStateSchema)),
  })
  .strict();
export type RunManifest = z.infer<typeof RunManifestSchema>;
