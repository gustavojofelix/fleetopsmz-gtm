import { createPesquisadorAgent } from '../agents/pesquisador/pesquisador.js';
import type { ProjectConfig } from '../config/project-config.js';
import { PipelineError } from '../infra/errors.js';
import type { Logger } from '../infra/logger.js';
import { createRateLimiter } from '../infra/rate-limiter.js';
import type { RetryOptions } from '../infra/retry.js';
import type { Clock } from '../ports/clock.js';
import type { LlmClient } from '../ports/llm.js';
import type { SearchProvider } from '../ports/search.js';
import type { RecordStore } from '../ports/store.js';
import { renderDossierMarkdown } from '../reporting/dossier-markdown.js';
import { countDossiers, renderResearchSummary } from '../reporting/stage-summaries.js';
import type { ResearchCounts } from '../reporting/stage-summaries.js';
import { RunIdSchema } from '../schemas/index.js';
import type { QualifiedLead, ResearchDossier } from '../schemas/index.js';
import { createSearchService } from '../tools/search.js';
import { STAGE_PATHS, companyFileStem, createJsonCache, toJson } from './run-store.js';
import { runStage, stageManifest } from './stage.js';
import type { StageFailure, StageSkip } from './stage.js';

/** Minimum spacing between search requests. */
const SEARCH_INTERVAL_MS = 300;

export interface RunPesquisadorInput {
  /** Leads already selected for research (see selectForResearch). */
  leads: QualifiedLead[];
  /** Leads that were not selected, listed in the summary. */
  held: StageSkip[];
  /** Qualification run the leads came from; null when it is this run. */
  sourceRun: string | null;
  force: boolean;
}

export interface RunPesquisadorDeps {
  store: RecordStore;
  config: ProjectConfig;
  llm: LlmClient;
  searchProvider: SearchProvider;
  prompt: string;
  model: string;
  runId: string;
  logger: Logger;
  clock: Clock;
  concurrency: number;
  retry?: Partial<RetryOptions>;
  /** Injected in tests so the rate limiter does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunPesquisadorResult {
  run_id: string;
  run_dir: string;
  dossiers: ResearchDossier[];
  failures: StageFailure[];
  counts: ResearchCounts;
  searches_run: number;
  cache_hits: number;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Runs Agent 2 over the selected leads and writes the research run folder.
 * Search results and model readings are cached as they arrive, so repeating
 * the command after an interruption costs nothing for finished companies.
 */
export async function runPesquisador(
  input: RunPesquisadorInput,
  deps: RunPesquisadorDeps,
): Promise<RunPesquisadorResult> {
  const { store, clock, logger } = deps;
  const runId = RunIdSchema.parse(deps.runId);
  const paths = STAGE_PATHS.researched;
  const runDir = `${paths.runs}/${runId}`;
  const startedAt = clock.now().toISOString();

  let searchesRun = 0;
  const provider: SearchProvider = {
    name: deps.searchProvider.name,
    search: async (query, options) => {
      searchesRun += 1;
      return deps.searchProvider.search(query, options);
    },
  };
  const search = createSearchService({
    provider,
    limiter: createRateLimiter({
      minIntervalMs: SEARCH_INTERVAL_MS,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    }),
    logger,
    cache: createJsonCache(store, paths.searchCache),
    force: input.force,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  });
  const agent = createPesquisadorAgent({
    llm: deps.llm,
    search,
    scoring: deps.config.scoring,
    geography: deps.config.geography,
    prompt: deps.prompt,
    cache: createJsonCache(store, paths.cache),
    force: input.force,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  });

  const manifestBase = {
    runId,
    agent: 'pesquisador' as const,
    promptVersion: agent.promptVersion,
    model: deps.model,
    startedAt,
  };
  await store.writeState(
    `${runDir}/manifest.json`,
    toJson(stageManifest({ ...manifestBase, finishedAt: null, states: {}, attempted: 0, succeeded: 0 })),
  );
  logger.info('research.started', { leads: input.leads.length, held: input.held.length });

  const outcome = await runStage({
    agent,
    items: input.leads,
    leadIdOf: (lead) => lead.lead_id,
    companyNameOf: (lead) => lead.company_name,
    runId,
    model: deps.model,
    logger,
    clock,
    concurrency: deps.concurrency,
  });
  if (outcome.skipped.length > 0) {
    throw new PipelineError({ code: 'internal', message: 'Agent 2 does not skip records' });
  }

  const dossiers = outcome.outputs.map((item) => item.output);
  const finishedAt = clock.now().toISOString();
  const counts = countDossiers(dossiers);

  await store.writeNew(`${runDir}/dossiers.json`, toJson(dossiers));
  for (const dossier of dossiers) {
    const stem = companyFileStem({
      city: dossier.lead.city,
      company_name: dossier.lead.company_name,
      lead_id: dossier.lead_id,
      date: finishedAt,
    });
    await store.writeNew(`${runDir}/dossiers/${stem}.json`, toJson(dossier));
    await store.writeNew(`${runDir}/dossiers/${stem}.md`, renderDossierMarkdown(dossier));
  }
  await store.writeNew(
    `${runDir}/research_summary.md`,
    renderResearchSummary({
      run_id: runId,
      generated_at: finishedAt,
      model: deps.model,
      prompt_version: agent.promptVersion,
      source_run: input.sourceRun,
      dossiers,
      held: input.held,
      failures: outcome.failures,
      searches_run: searchesRun,
      cache_hits: outcome.cache_hits,
      usage: outcome.usage,
    }),
  );
  await store.writeNew(
    `${runDir}/summary.json`,
    toJson({
      run_id: runId,
      agent: 'pesquisador',
      finished_at: finishedAt,
      source_run: input.sourceRun,
      attempted: input.leads.length,
      held: input.held.length,
      failed: outcome.failures.length,
      searches_run: searchesRun,
      cache_hits: outcome.cache_hits,
      usage: outcome.usage,
      counts,
    }),
  );
  if (outcome.failures.length > 0) {
    await store.writeNew(
      `${runDir}/failures.jsonl`,
      `${outcome.failures.map((failure) => JSON.stringify(failure)).join('\n')}\n`,
    );
  }
  await store.writeState(
    `${runDir}/manifest.json`,
    toJson(
      stageManifest({
        ...manifestBase,
        finishedAt,
        states: outcome.states,
        attempted: input.leads.length,
        succeeded: dossiers.length,
      }),
    ),
  );
  await store.writeState(paths.latest, `${runId}\n`);

  logger.info('research.finished', {
    dossiers: dossiers.length,
    failed: outcome.failures.length,
    complete: counts.complete,
    partial: counts.partial,
    insufficient: counts.insufficient,
    searches_run: searchesRun,
    cache_hits: outcome.cache_hits,
    usage: outcome.usage,
  });

  return {
    run_id: runId,
    run_dir: runDir,
    dossiers,
    failures: outcome.failures,
    counts,
    searches_run: searchesRun,
    cache_hits: outcome.cache_hits,
    usage: outcome.usage,
  };
}
