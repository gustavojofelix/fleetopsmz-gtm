import { createMineradorAgent } from '../agents/minerador/minerador.js';
import type { ProjectConfig } from '../config/project-config.js';
import { emptyRegistry, resolveLeads } from '../domain/dedupe.js';
import { mapWithConcurrency } from '../infra/concurrency.js';
import { PipelineError } from '../infra/errors.js';
import type { Logger } from '../infra/logger.js';
import type { RetryOptions } from '../infra/retry.js';
import type { Clock } from '../ports/clock.js';
import type { LlmClient } from '../ports/llm.js';
import type { RecordStore } from '../ports/store.js';
import { LeadRegistrySchema, RunIdSchema } from '../schemas/index.js';
import type {
  LeadCandidate,
  LeadRegistry,
  QualifiedLead,
  RejectedRawRow,
  RunManifest,
  StageState,
} from '../schemas/index.js';
import { leadsToCsv, rejectedRowsToCsv } from '../reporting/leads-csv.js';
import { countLeads, renderQualificationSummary } from '../reporting/qualification-summary.js';
import type { QualificationCounts } from '../reporting/qualification-summary.js';
import { importRawContent } from '../tools/import.js';
import { createJsonCache, toJson } from './run-store.js';

/** Where Agent 1 reads and writes, relative to the project root. */
export const MINERADOR_PATHS = {
  registry: 'data/registry/registry.json',
  registrySnapshots: 'data/registry/snapshots',
  runs: 'data/qualified/runs',
  latest: 'data/qualified/LATEST',
  cache: 'data/qualified/cache',
} as const;

export interface RunMineradorInput {
  /** Raw files, already read by the caller. They are never written to. */
  files: { path: string; content: string }[];
  /** Maximum number of companies to assess in this run. */
  limit: number;
  /** Import and deduplicate only: no model calls, nothing written. */
  dryRun: boolean;
  /** Ignore cached assessments. */
  force: boolean;
}

export interface RunMineradorDeps {
  store: RecordStore;
  config: ProjectConfig;
  /** May be null for a dry run. */
  llm: LlmClient | null;
  prompt: string;
  model: string;
  runId: string;
  logger: Logger;
  clock: Clock;
  concurrency: number;
  retry?: Partial<RetryOptions>;
}

export interface RunFailure {
  lead_id: string;
  company_name: string;
  code: string;
  message: string;
}

export interface RunMineradorResult {
  run_id: string;
  dry_run: boolean;
  /** Folder holding this run's outputs. Null for a dry run. */
  run_dir: string | null;
  input_rows: number;
  valid_rows: number;
  merged_rows: number;
  candidates: number;
  new_leads: number;
  not_processed: number;
  cache_hits: number;
  usage: { input_tokens: number; output_tokens: number };
  counts: QualificationCounts;
  leads: QualifiedLead[];
  failures: RunFailure[];
  rejected: RejectedRawRow[];
}

async function loadRegistry(store: RecordStore): Promise<LeadRegistry> {
  if (!(await store.exists(MINERADOR_PATHS.registry))) return emptyRegistry();
  const parsed = LeadRegistrySchema.safeParse(await store.readJson(MINERADOR_PATHS.registry));
  if (!parsed.success) {
    throw new PipelineError({
      code: 'config',
      message: `${MINERADOR_PATHS.registry} is not a valid lead registry`,
      context: { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  return parsed.data;
}


/**
 * Runs Agent 1 over a batch: import, deduplicate, resolve lead_ids, assess
 * each company, then write the run folder and update the lead registry.
 *
 * A failing company is recorded and the batch continues. If the run is
 * interrupted, running the same command again reuses every assessment already
 * completed, because model results are cached as they arrive.
 */
export async function runMinerador(
  input: RunMineradorInput,
  deps: RunMineradorDeps,
): Promise<RunMineradorResult> {
  const { store, config, logger, clock } = deps;
  const runId = RunIdSchema.parse(deps.runId);
  const startedAt = clock.now().toISOString();

  // 1. Import.
  const imported = input.files.map((file) =>
    importRawContent({ fileName: file.path, content: file.content, importedAt: startedAt }),
  );
  const records = imported.flatMap((file) => file.records);
  const rejected = imported.flatMap((file) => file.rejected);
  const inputRows = imported.reduce((sum, file) => sum + file.total_rows, 0);
  logger.info('import.done', {
    files: imported.length,
    rows: inputRows,
    valid: records.length,
    rejected: rejected.length,
  });

  // 2. Deduplicate and resolve identities.
  const registryBefore = await loadRegistry(store);
  const resolved = resolveLeads(records, registryBefore, config.geography, {
    run_id: runId,
    now: startedAt,
  });
  const selected = resolved.candidates.slice(0, input.limit);
  const notProcessed = resolved.candidates.length - selected.length;
  logger.info('dedupe.done', {
    candidates: resolved.candidates.length,
    merged_rows: resolved.merged_rows,
    new_leads: resolved.candidates.filter((c) => c.is_new).length,
    selected: selected.length,
    not_processed: notProcessed,
  });

  const base = {
    run_id: runId,
    input_rows: inputRows,
    valid_rows: records.length,
    merged_rows: resolved.merged_rows,
    candidates: resolved.candidates.length,
    new_leads: resolved.candidates.filter((c) => c.is_new).length,
    rejected,
  };

  if (input.dryRun) {
    return {
      ...base,
      dry_run: true,
      run_dir: null,
      not_processed: resolved.candidates.length,
      cache_hits: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      counts: countLeads([]),
      leads: [],
      failures: [],
    };
  }

  if (deps.llm === null) {
    throw new PipelineError({ code: 'config', message: 'A model client is required to run Agent 1' });
  }

  // 3. Assess.
  const agent = createMineradorAgent({
    llm: deps.llm,
    scoring: config.scoring,
    prompt: deps.prompt,
    cache: createJsonCache(store, MINERADOR_PATHS.cache),
    force: input.force,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  });
  const runDir = `${MINERADOR_PATHS.runs}/${runId}`;
  const inputFiles = imported.map((file) => ({
    path: file.source_file,
    sha256: file.sha256,
    rows: file.total_rows,
  }));
  const manifest: RunManifest = {
    schema_version: 1,
    run_id: runId,
    status: 'running',
    agents: ['minerador'],
    started_at: startedAt,
    finished_at: null,
    input_files: inputFiles,
    model: deps.model,
    prompt_versions: { minerador: agent.promptVersion },
    records: {},
  };
  await store.writeState(`${runDir}/manifest.json`, toJson(manifest));

  const leads: QualifiedLead[] = [];
  const failures: RunFailure[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let cacheHits = 0;

  const outcomes = await mapWithConcurrency(
    selected,
    deps.concurrency,
    async (candidate: LeadCandidate) => {
      const started = clock.now().getTime();
      const log = logger.child({ agent: 'minerador', lead_id: candidate.lead_id });
      const result = await agent.run(candidate, { runId, model: deps.model, logger: log, clock });
      const duration_ms = clock.now().getTime() - started;
      if (result.status === 'ok') {
        log.info('lead.assessed', {
          duration_ms,
          from_cache: result.fromCache === true,
          score: result.output.icp.score,
          priority: result.output.icp.priority,
          status: result.output.qualification_status,
          usage: result.usage,
        });
      } else if (result.status === 'failed') {
        log.error('lead.failed', { duration_ms, error: result.error });
      }
      return { candidate, result };
    },
  );

  for (const { candidate, result } of outcomes) {
    const state: StageState = {
      status: result.status,
      idempotency_key: null,
      attempts: 1,
      error_code: result.status === 'failed' ? result.error.code : null,
      updated_at: clock.now().toISOString(),
    };
    manifest.records[candidate.lead_id] = { minerador: state };
    if (result.status === 'ok') {
      leads.push(result.output);
      if (result.fromCache === true) cacheHits += 1;
      if (result.usage !== null) {
        usage.input_tokens += result.usage.input_tokens;
        usage.output_tokens += result.usage.output_tokens;
      }
    } else if (result.status === 'failed') {
      failures.push({
        lead_id: candidate.lead_id,
        company_name: candidate.company_name,
        code: result.error.code,
        message: result.error.message,
      });
    }
  }

  // 4. Write the run folder. Files are created once and never replaced.
  const finishedAt = clock.now().toISOString();
  await store.writeNew(`${runDir}/qualified_companies.json`, toJson(leads));
  await store.writeNew(`${runDir}/qualified_companies.csv`, leadsToCsv(leads));
  await store.writeNew(
    `${runDir}/qualification_summary.md`,
    renderQualificationSummary({
      run_id: runId,
      generated_at: finishedAt,
      model: deps.model,
      prompt_version: agent.promptVersion,
      input_files: inputFiles,
      valid_rows: records.length,
      merged_rows: resolved.merged_rows,
      candidates: resolved.candidates.length,
      not_processed: notProcessed,
      cache_hits: cacheHits,
      usage,
      leads,
      failures,
      rejected,
    }),
  );
  if (rejected.length > 0) {
    await store.writeNew(`${runDir}/rejected_rows.csv`, rejectedRowsToCsv(rejected));
  }
  if (failures.length > 0) {
    await store.writeNew(
      `${runDir}/failures.jsonl`,
      `${failures.map((failure) => JSON.stringify(failure)).join('\n')}\n`,
    );
  }

  const counts = countLeads(leads);
  await store.writeNew(
    `${runDir}/summary.json`,
    toJson({
      run_id: runId,
      agent: 'minerador',
      finished_at: finishedAt,
      input_rows: inputRows,
      valid_rows: records.length,
      rejected_rows: rejected.length,
      merged_rows: resolved.merged_rows,
      candidates: resolved.candidates.length,
      assessed: leads.length,
      failed: failures.length,
      not_processed: notProcessed,
      cache_hits: cacheHits,
      usage,
      counts,
    }),
  );

  // 5. Persist identities, then mark the run finished.
  await store.writeNew(`${MINERADOR_PATHS.registrySnapshots}/${runId}.json`, toJson(resolved.registry));
  await store.writeState(MINERADOR_PATHS.registry, toJson(resolved.registry));

  manifest.status = selected.length > 0 && leads.length === 0 ? 'failed' : 'completed';
  manifest.finished_at = finishedAt;
  await store.writeState(`${runDir}/manifest.json`, toJson(manifest));
  await store.writeState(MINERADOR_PATHS.latest, `${runId}\n`);

  logger.info('run.finished', {
    status: manifest.status,
    assessed: leads.length,
    failed: failures.length,
    qualified: counts.qualified,
    manual_review: counts.manual_review,
    low_priority: counts.low_priority,
    cache_hits: cacheHits,
    usage,
  });

  return {
    ...base,
    dry_run: false,
    run_dir: runDir,
    not_processed: notProcessed,
    cache_hits: cacheHits,
    usage,
    counts,
    leads,
    failures,
    rejected,
  };
}
