/**
 * Command implementations for the CLI. They wire real adapters (filesystem,
 * Anthropic, Serper) to the orchestration functions; the logic itself lives in
 * src/orchestration and is tested there with fakes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createAnthropicLlmClient } from '../adapters/anthropic.js';
import { createFsStore } from '../adapters/fs-store.js';
import { createSerperProvider } from '../adapters/serper.js';
import {
  assertEnvFor,
  loadDotEnv,
  missingVariables,
  parseEnv,
  secretValues,
} from '../config/env.js';
import type { Env } from '../config/env.js';
import { loadProjectConfig, senderProblems } from '../config/project-config.js';
import { commercialDraftsEnabled } from '../domain/capability-gate.js';
import { selectForResearch } from '../domain/gates.js';
import { PipelineError } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import type { Logger } from '../infra/logger.js';
import {
  RUN_FILES,
  latestPerKey,
  loadApprovals,
  loadDossiers,
  loadFromAllRuns,
  loadPromotions,
  loadQualifiedLeads,
} from '../orchestration/load.js';
import { runCopywriter } from '../orchestration/run-copywriter.js';
import { createRunId } from '../orchestration/run-id.js';
import { MINERADOR_PATHS, runMinerador } from '../orchestration/run-minerador.js';
import { runPesquisador } from '../orchestration/run-pesquisador.js';
import { STAGE_PATHS, resolveSourceRun, toJson } from '../orchestration/run-store.js';
import type { StageSkip } from '../orchestration/stage.js';
import { systemClock } from '../ports/clock.js';
import type { LlmClient } from '../ports/llm.js';
import type { RecordStore } from '../ports/store.js';
import { renderKpiReport } from '../reporting/kpi-report.js';
import { approvedToCsv } from '../reporting/outreach-export.js';
import type { OutreachEntry } from '../reporting/outreach-export.js';
import {
  LeadRegistrySchema,
  OutreachPackageSchema,
  QualifiedLeadSchema,
  ResearchDossierSchema,
} from '../schemas/index.js';
import type {
  AgentName,
  CapabilityStatus,
  OutreachDraft,
  QualifiedLead,
  ResearchDossier,
} from '../schemas/index.js';

const ALL_AGENTS: readonly AgentName[] = ['minerador', 'pesquisador', 'copywriter'];
const PROMPT_FILES: Record<AgentName, string> = {
  minerador: 'prompts/01_minerador.md',
  pesquisador: 'prompts/02_pesquisador.md',
  copywriter: 'prompts/03_copywriter.md',
};

function configError(message: string): PipelineError {
  return new PipelineError({ code: 'config', message });
}

async function readPrompt(rootDir: string, agent: AgentName): Promise<string> {
  try {
    return await readFile(join(rootDir, PROMPT_FILES[agent]), 'utf8');
  } catch (cause) {
    throw new PipelineError({ code: 'config', message: `Cannot read ${PROMPT_FILES[agent]}`, cause });
  }
}

/** Parses "--agents a,b" into pipeline order and checks the stages are adjacent. */
export function parseAgents(value: string): AgentName[] {
  const requested = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  const unknown = requested.filter((name) => !ALL_AGENTS.includes(name as AgentName));
  if (unknown.length > 0 || requested.length === 0) {
    throw configError(`--agents accepts: ${ALL_AGENTS.join(', ')} (got "${value}")`);
  }
  const agents = ALL_AGENTS.filter((agent) => requested.includes(agent));
  const positions = agents.map((agent) => ALL_AGENTS.indexOf(agent));
  const adjacent = positions.every((p, i) => i === 0 || p === (positions[i - 1] ?? 0) + 1);
  if (!adjacent) {
    throw configError('--agents must name adjacent stages, e.g. "minerador,pesquisador"');
  }
  return agents;
}

// ---------------------------------------------------------------- check-config

export async function checkConfig(rootDir: string): Promise<number> {
  const dotEnvLoaded = loadDotEnv();
  const env = parseEnv(process.env);
  const logger = createLogger({ level: env.LOG_LEVEL, secrets: secretValues(env) });
  const config = await loadProjectConfig(rootDir);

  const statusCounts: Partial<Record<CapabilityStatus, number>> = {};
  for (const capability of config.capabilities.capabilities) {
    statusCounts[capability.status] = (statusCounts[capability.status] ?? 0) + 1;
  }
  logger.info('config.checked', {
    dot_env_loaded: dotEnvLoaded,
    search_provider: env.SEARCH_PROVIDER,
    model_configured: env.ANTHROPIC_MODEL !== undefined,
    max_concurrency: env.MAX_CONCURRENCY,
    default_batch_limit: env.DEFAULT_BATCH_LIMIT,
    capability_statuses: statusCounts,
    commercial_drafts_enabled: commercialDraftsEnabled(config.capabilities),
    outreach_sender_problems: senderProblems(config.outreach),
    scoring_criteria: config.scoring.criteria.length,
    coverage_threshold: config.scoring.coverage_threshold,
    cities: config.geography.cities.length,
    missing_by_agent: Object.fromEntries(
      ALL_AGENTS.map((agent) => [agent, missingVariables([agent], env)]),
    ),
  });
  return 0;
}

// ------------------------------------------------------------------------- run

interface RunSetup {
  env: Env;
  store: RecordStore;
  logger: Logger;
  runId: string;
}

async function createLlm(env: Env): Promise<LlmClient> {
  // Loaded on demand so dry runs and tests do not need the SDK.
  const { createAnthropicMessagesApi } = await import('../adapters/anthropic-sdk.js');
  return createAnthropicLlmClient(createAnthropicMessagesApi(env.ANTHROPIC_API_KEY ?? ''));
}

export async function runCommand(rootDir: string, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      input: { type: 'string', multiple: true },
      company: { type: 'string' },
      city: { type: 'string' },
      website: { type: 'string' },
      agents: { type: 'string', default: 'minerador' },
      limit: { type: 'string' },
      'confirm-large': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'from-run': { type: 'string' },
      lead: { type: 'string' },
    },
    strict: true,
  });

  const agents = parseAgents(values.agents);
  const first = agents[0];
  const dryRun = values['dry-run'];
  const inputs = values.input ?? [];

  if (first === 'minerador') {
    if (inputs.length === 0 && values.company === undefined) {
      throw configError('Provide --input <file> or --company "<name>".');
    }
    if (values['from-run'] !== undefined) throw configError('--from-run cannot be used with minerador.');
  } else {
    if (inputs.length > 0 || values.company !== undefined) {
      throw configError('--input and --company need "minerador" in --agents.');
    }
    if (dryRun) throw configError('--dry-run only applies to minerador.');
  }

  loadDotEnv();
  const env = parseEnv(process.env);
  const limit = values.limit === undefined ? env.DEFAULT_BATCH_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw configError('--limit must be a positive integer.');
  if (!dryRun && limit > env.DEFAULT_BATCH_LIMIT && !values['confirm-large']) {
    throw configError(
      `--limit ${limit} exceeds the default batch limit of ${env.DEFAULT_BATCH_LIMIT}. ` +
        'Review a small batch first, then add --confirm-large.',
    );
  }
  if (!dryRun) assertEnvFor(agents, env);
  if (agents.includes('pesquisador') && env.SEARCH_PROVIDER !== 'serper') {
    throw configError('Only SEARCH_PROVIDER=serper is implemented.');
  }

  const config = await loadProjectConfig(rootDir);
  if (agents.includes('copywriter')) {
    const problems = senderProblems(config.outreach);
    if (problems.length > 0) {
      throw configError(`config/outreach.json is incomplete: ${problems.join('; ')}`);
    }
  }

  // Raw input for Agent 1. Files are read here and never written to.
  const files: { path: string; content: string }[] = [];
  for (const input of inputs) {
    const absolute = resolve(rootDir, input);
    try {
      files.push({
        path: relative(rootDir, absolute).split('\\').join('/'),
        content: await readFile(absolute, 'utf8'),
      });
    } catch (cause) {
      throw new PipelineError({
        code: 'input_validation',
        message: `Cannot read input file: ${input}`,
        cause,
      });
    }
  }
  if (values.company !== undefined) {
    files.push({
      path: 'command-line.json',
      content: JSON.stringify([
        { company_name: values.company, city: values.city ?? null, website: values.website ?? null },
      ]),
    });
  }

  const runId = createRunId(systemClock.now());
  const runsDir = join(rootDir, STAGE_PATHS.runParams);
  const logFile = join(runsDir, `${runId}.log.jsonl`);
  if (!dryRun) mkdirSync(runsDir, { recursive: true });
  const logger = createLogger({
    level: env.LOG_LEVEL,
    secrets: secretValues(env),
    bindings: { run_id: runId },
    write: (line) => {
      process.stdout.write(`${line}\n`);
      if (!dryRun) appendFileSync(logFile, `${line}\n`, 'utf8');
    },
  });
  const setup: RunSetup = { env, store: createFsStore(rootDir), logger, runId };
  const { store } = setup;
  const model = env.ANTHROPIC_MODEL ?? '';
  const shared = { store, config, model, runId, logger, clock: systemClock, concurrency: env.MAX_CONCURRENCY };

  if (!dryRun) {
    await store.writeNew(
      `${STAGE_PATHS.runParams}/${runId}.json`,
      toJson({ run_id: runId, started_at: systemClock.now().toISOString(), args: [...args] }),
    );
  }
  logger.info('run.started', {
    agents,
    inputs: files.map((file) => file.path),
    limit,
    dry_run: dryRun,
    force: values.force,
    from_run: values['from-run'] ?? null,
    lead: values.lead ?? null,
    model: env.ANTHROPIC_MODEL ?? null,
  });

  const llm = dryRun ? null : await createLlm(env);
  const summaries: string[] = [];
  let leads: QualifiedLead[] | null = null;
  let dossiers: ResearchDossier[] | null = null;

  // Stage 1.
  if (agents.includes('minerador')) {
    const result = await runMinerador(
      { files, limit, dryRun, force: values.force },
      { ...shared, llm, prompt: dryRun ? '' : await readPrompt(rootDir, 'minerador') },
    );
    if (result.dry_run) {
      logger.info('run.dry_run', {
        input_rows: result.input_rows,
        valid_rows: result.valid_rows,
        rejected_rows: result.rejected.length,
        merged_rows: result.merged_rows,
        companies: result.candidates,
        new_leads: result.new_leads,
      });
      return 0;
    }
    leads = result.leads;
    summaries.push(`${result.run_dir}/qualification_summary.md`);
  }
  if (llm === null) throw configError('A model client is required.');

  // Stage 2.
  if (agents.includes('pesquisador')) {
    let sourceRun: string | null = null;
    if (leads === null) {
      sourceRun = await resolveSourceRun(store, STAGE_PATHS.qualified, values['from-run']);
      leads = await loadQualifiedLeads(store, sourceRun);
    }
    const promotions = await loadPromotions(store);
    for (const problem of promotions.problems) logger.warn('reviews.problem', { problem });

    let selection = selectForResearch(leads, promotions.latest);
    if (values.lead !== undefined) {
      const chosen = leads.filter((lead) => lead.lead_id === values.lead);
      if (chosen.length === 0) throw configError(`Lead not found in the source run: ${values.lead}`);
      // Naming a lead is an explicit human decision to research it.
      selection = { selected: chosen, held: [] };
    }
    const held: StageSkip[] = selection.held.map((item) => ({
      lead_id: item.lead.lead_id,
      company_name: item.lead.company_name,
      reason: item.reason,
    }));
    let selected = selection.selected;
    if (first === 'pesquisador' && selected.length > limit) {
      held.push(
        ...selected.slice(limit).map((lead) => ({
          lead_id: lead.lead_id,
          company_name: lead.company_name,
          reason: 'not processed (batch limit)',
        })),
      );
      selected = selected.slice(0, limit);
    }
    const result = await runPesquisador(
      { leads: selected, held, sourceRun, force: values.force },
      {
        ...shared,
        llm,
        searchProvider: createSerperProvider({ apiKey: env.SERPER_API_KEY ?? '' }),
        prompt: await readPrompt(rootDir, 'pesquisador'),
      },
    );
    dossiers = result.dossiers;
    summaries.push(`${result.run_dir}/research_summary.md`);
  }

  // Stage 3.
  if (agents.includes('copywriter')) {
    let sourceRun: string | null = null;
    if (dossiers === null) {
      sourceRun = await resolveSourceRun(store, STAGE_PATHS.researched, values['from-run']);
      dossiers = await loadDossiers(store, sourceRun);
      if (values.lead !== undefined) {
        dossiers = dossiers.filter((dossier) => dossier.lead_id === values.lead);
        if (dossiers.length === 0) throw configError(`Lead not found in the source run: ${values.lead}`);
      }
      dossiers = dossiers.slice(0, limit);
    }
    const result = await runCopywriter(
      { dossiers, sourceRun, force: values.force },
      { ...shared, llm, prompt: await readPrompt(rootDir, 'copywriter') },
    );
    summaries.push(`${result.run_dir}/outreach_summary.md`);
  }

  process.stdout.write(`\nRun ${runId} finished. Summaries:\n${summaries.map((s) => `  ${s}`).join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------- resume

/** Repeats an earlier run with the same options. Finished work comes from the cache. */
export async function resumeCommand(rootDir: string, args: readonly string[]): Promise<number> {
  const runId = args[0];
  if (runId === undefined) throw configError('Usage: resume <run_id>');
  const store = createFsStore(rootDir);
  const path = `${STAGE_PATHS.runParams}/${runId}.json`;
  if (!(await store.exists(path))) throw configError(`No saved options for run ${runId} (${path}).`);
  const saved = z.object({ args: z.array(z.string()) }).safeParse(await store.readJson(path));
  if (!saved.success) throw configError(`${path} is not readable.`);
  process.stdout.write(`Repeating run ${runId} with: ${saved.data.args.join(' ')}\n`);
  return runCommand(rootDir, saved.data.args);
}

// ---------------------------------------------------------------------- report

async function loadLatestState(store: RecordStore) {
  const qualified = await loadFromAllRuns(
    store,
    STAGE_PATHS.qualified.runs,
    RUN_FILES.leads,
    z.array(QualifiedLeadSchema),
  );
  const researched = await loadFromAllRuns(
    store,
    STAGE_PATHS.researched.runs,
    RUN_FILES.dossiers,
    z.array(ResearchDossierSchema),
  );
  const outreach = await loadFromAllRuns(
    store,
    STAGE_PATHS.outreach.runs,
    RUN_FILES.packages,
    z.array(OutreachPackageSchema),
  );
  return {
    leads: latestPerKey(qualified.runs, (lead) => lead.lead_id),
    dossiers: latestPerKey(researched.runs, (dossier) => dossier.lead_id),
    packages: latestPerKey(outreach.runs, (pkg) => pkg.lead_id),
    problems: [...qualified.problems, ...researched.problems, ...outreach.problems],
  };
}

function fileStamp(): string {
  return systemClock.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
}

export async function reportCommand(rootDir: string): Promise<number> {
  const store = createFsStore(rootDir);
  const state = await loadLatestState(store);
  const approvals = await loadApprovals(store);
  const summaries = await loadFromAllRuns(
    store,
    STAGE_PATHS.qualified.runs,
    'summary.json',
    z.object({ valid_rows: z.number(), merged_rows: z.number() }).passthrough(),
  );
  let registered = 0;
  if (await store.exists(MINERADOR_PATHS.registry)) {
    const registry = LeadRegistrySchema.safeParse(await store.readJson(MINERADOR_PATHS.registry));
    if (registry.success) registered = registry.data.entries.length;
  }
  const report = renderKpiReport({
    generated_at: systemClock.now().toISOString(),
    registered_leads: registered,
    leads: state.leads,
    dossiers: state.dossiers,
    packages: state.packages,
    approvals: approvals.latest,
    import_totals: {
      valid_rows: summaries.runs.reduce((sum, run) => sum + run.data.valid_rows, 0),
      merged_rows: summaries.runs.reduce((sum, run) => sum + run.data.merged_rows, 0),
    },
  });
  const path = `${STAGE_PATHS.reports}/kpi_${fileStamp()}.md`;
  await store.writeNew(path, report);
  for (const problem of [...state.problems, ...approvals.problems]) {
    process.stderr.write(`Warning: ${problem}\n`);
  }
  process.stdout.write(`KPI report: ${path}\n`);
  return 0;
}

// ------------------------------------------------------------- export-approved

/**
 * Writes the drafts a person approved to a CSV, ready to be sent by hand.
 * This is the end of the pipeline: nothing in this system sends a message.
 */
export async function exportApprovedCommand(rootDir: string): Promise<number> {
  const store = createFsStore(rootDir);
  const config = await loadProjectConfig(rootDir);
  const state = await loadLatestState(store);
  const approvals = await loadApprovals(store);
  for (const problem of approvals.problems) process.stderr.write(`Warning: ${problem}\n`);

  const dossierByLead = new Map(state.dossiers.map((dossier) => [dossier.lead_id, dossier]));
  const approved: { entry: OutreachEntry; draft: OutreachDraft; reviewer: string; decided_at: string }[] = [];
  const unmatched = new Set(
    [...approvals.latest.values()].filter((a) => a.decision === 'approved').map((a) => a.draft_id),
  );
  for (const pkg of state.packages) {
    const dossier = dossierByLead.get(pkg.lead_id);
    if (dossier === undefined) continue;
    for (const draft of pkg.drafts) {
      const decision = approvals.latest.get(draft.draft_id);
      if (decision?.decision !== 'approved') continue;
      unmatched.delete(draft.draft_id);
      approved.push({
        entry: { dossier, pkg },
        draft,
        reviewer: decision.reviewer,
        decided_at: decision.decided_at,
      });
    }
  }
  for (const draftId of unmatched) {
    process.stderr.write(`Warning: approved draft ${draftId} was not found in the latest outreach runs.\n`);
  }
  if (approved.length === 0) {
    process.stdout.write('No approved drafts found. Add rows to data/reviews/approvals.csv first.\n');
    return 0;
  }
  const path = `${STAGE_PATHS.outreach.runs.replace(/\/runs$/, '')}/approved/approved_${fileStamp()}.csv`;
  await store.writeNew(path, approvedToCsv(approved, config.outreach.sender));
  process.stdout.write(`${approved.length} approved draft(s): ${path}\nSend them manually.\n`);
  return 0;
}
