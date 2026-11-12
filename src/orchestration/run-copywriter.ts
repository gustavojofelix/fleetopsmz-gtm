import { createCopywriterAgent } from '../agents/copywriter/copywriter.js';
import type { ProjectConfig } from '../config/project-config.js';
import { senderProblems } from '../config/project-config.js';
import { commercialDraftsEnabled } from '../domain/capability-gate.js';
import { PipelineError } from '../infra/errors.js';
import type { Logger } from '../infra/logger.js';
import type { RetryOptions } from '../infra/retry.js';
import type { Clock } from '../ports/clock.js';
import type { LlmClient } from '../ports/llm.js';
import type { RecordStore } from '../ports/store.js';
import { renderDossierMarkdown } from '../reporting/dossier-markdown.js';
import { outreachToCsv, renderOutreachMarkdown } from '../reporting/outreach-export.js';
import type { OutreachEntry } from '../reporting/outreach-export.js';
import { renderOutreachSummary } from '../reporting/stage-summaries.js';
import { RunIdSchema } from '../schemas/index.js';
import type { ResearchDossier } from '../schemas/index.js';
import { STAGE_PATHS, companyFileStem, createJsonCache, toJson } from './run-store.js';
import { runStage, stageManifest } from './stage.js';
import type { StageFailure, StageSkip } from './stage.js';

export interface RunCopywriterInput {
  dossiers: ResearchDossier[];
  /** Research run the dossiers came from; null when it is this run. */
  sourceRun: string | null;
  force: boolean;
}

export interface RunCopywriterDeps {
  store: RecordStore;
  config: ProjectConfig;
  llm: LlmClient;
  prompt: string;
  model: string;
  runId: string;
  logger: Logger;
  clock: Clock;
  concurrency: number;
  retry?: Partial<RetryOptions>;
}

export interface RunCopywriterResult {
  run_id: string;
  run_dir: string;
  draft_type: 'institutional_intro' | 'commercial';
  packages: OutreachEntry[];
  drafts: number;
  skipped: StageSkip[];
  failures: StageFailure[];
  cache_hits: number;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Runs Agent 3 over researched companies and writes the outreach-ready run
 * folder. Everything written is a draft pending human review. This function
 * has no way to send a message.
 */
export async function runCopywriter(
  input: RunCopywriterInput,
  deps: RunCopywriterDeps,
): Promise<RunCopywriterResult> {
  const { store, clock, logger, config } = deps;
  const runId = RunIdSchema.parse(deps.runId);
  const paths = STAGE_PATHS.outreach;
  const runDir = `${paths.runs}/${runId}`;
  const startedAt = clock.now().toISOString();

  const sender = senderProblems(config.outreach);
  if (sender.length > 0) {
    throw new PipelineError({
      code: 'config',
      message: `config/outreach.json is incomplete: ${sender.join('; ')}`,
    });
  }
  const draftType = commercialDraftsEnabled(config.capabilities) ? 'commercial' : 'institutional_intro';

  const agent = createCopywriterAgent({
    llm: deps.llm,
    registry: config.capabilities,
    outreach: config.outreach,
    prompt: deps.prompt,
    cache: createJsonCache(store, paths.cache),
    force: input.force,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  });
  const manifestBase = {
    runId,
    agent: 'copywriter' as const,
    promptVersion: agent.promptVersion,
    model: deps.model,
    startedAt,
  };
  await store.writeState(
    `${runDir}/manifest.json`,
    toJson(stageManifest({ ...manifestBase, finishedAt: null, states: {}, attempted: 0, succeeded: 0 })),
  );
  logger.info('copywriting.started', { dossiers: input.dossiers.length, draft_type: draftType });

  const outcome = await runStage({
    agent,
    items: input.dossiers,
    leadIdOf: (dossier) => dossier.lead_id,
    companyNameOf: (dossier) => dossier.lead.company_name,
    runId,
    model: deps.model,
    logger,
    clock,
    concurrency: deps.concurrency,
  });

  const packages: OutreachEntry[] = outcome.outputs.map((item) => ({
    dossier: item.input,
    pkg: item.output,
  }));
  const drafts = packages.reduce((sum, entry) => sum + entry.pkg.drafts.length, 0);
  const finishedAt = clock.now().toISOString();

  await store.writeNew(`${runDir}/outreach_packages.json`, toJson(packages.map((entry) => entry.pkg)));
  await store.writeNew(`${runDir}/outreach_ready.csv`, outreachToCsv(packages, config.outreach.sender));
  for (const entry of packages) {
    const folder = `${runDir}/companies/${companyFileStem({
      city: entry.dossier.lead.city,
      company_name: entry.dossier.lead.company_name,
      lead_id: entry.dossier.lead_id,
      date: finishedAt,
    })}`;
    await store.writeNew(`${folder}/dossier.md`, renderDossierMarkdown(entry.dossier));
    await store.writeNew(`${folder}/dossier.json`, toJson(entry.dossier));
    await store.writeNew(`${folder}/outreach.md`, renderOutreachMarkdown(entry, config.outreach.sender));
    await store.writeNew(`${folder}/outreach.json`, toJson(entry.pkg));
  }
  await store.writeNew(
    `${runDir}/outreach_summary.md`,
    renderOutreachSummary({
      run_id: runId,
      generated_at: finishedAt,
      model: deps.model,
      prompt_version: agent.promptVersion,
      source_run: input.sourceRun,
      draft_type: draftType,
      packages,
      skipped: outcome.skipped,
      failures: outcome.failures,
      cache_hits: outcome.cache_hits,
      usage: outcome.usage,
    }),
  );
  await store.writeNew(
    `${runDir}/summary.json`,
    toJson({
      run_id: runId,
      agent: 'copywriter',
      finished_at: finishedAt,
      source_run: input.sourceRun,
      draft_type: draftType,
      attempted: input.dossiers.length,
      companies_with_drafts: packages.length,
      drafts,
      skipped: outcome.skipped.length,
      failed: outcome.failures.length,
      cache_hits: outcome.cache_hits,
      usage: outcome.usage,
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
        attempted: input.dossiers.length,
        succeeded: packages.length,
      }),
    ),
  );
  await store.writeState(paths.latest, `${runId}\n`);

  logger.info('copywriting.finished', {
    companies_with_drafts: packages.length,
    drafts,
    skipped: outcome.skipped.length,
    failed: outcome.failures.length,
    cache_hits: outcome.cache_hits,
    usage: outcome.usage,
  });

  return {
    run_id: runId,
    run_dir: runDir,
    draft_type: draftType,
    packages,
    drafts,
    skipped: outcome.skipped,
    failures: outcome.failures,
    cache_hits: outcome.cache_hits,
    usage: outcome.usage,
  };
}
