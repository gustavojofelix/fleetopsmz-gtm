import type { Agent } from '../agents/agent.js';
import { mapWithConcurrency } from '../infra/concurrency.js';
import type { Logger } from '../infra/logger.js';
import type { Clock } from '../ports/clock.js';
import type { AgentName, RunId, RunManifest, StageState } from '../schemas/index.js';

export interface StageFailure {
  lead_id: string;
  company_name: string;
  code: string;
  message: string;
}

export interface StageSkip {
  lead_id: string;
  company_name: string;
  reason: string;
}

export interface StageOutcome<Input, Output> {
  outputs: { input: Input; output: Output }[];
  failures: StageFailure[];
  skipped: StageSkip[];
  usage: { input_tokens: number; output_tokens: number };
  cache_hits: number;
  states: Record<string, StageState>;
}

export interface StageOptions<Input, Output> {
  agent: Agent<Input, Output>;
  items: readonly Input[];
  leadIdOf: (item: Input) => string;
  companyNameOf: (item: Input) => string;
  runId: RunId;
  model: string;
  logger: Logger;
  clock: Clock;
  concurrency: number;
}

/**
 * Runs one agent over a batch with bounded concurrency. Each record is
 * isolated: a failure or a skip is recorded and the batch continues.
 */
export async function runStage<Input, Output>(
  options: StageOptions<Input, Output>,
): Promise<StageOutcome<Input, Output>> {
  const { agent, clock } = options;
  const outcome: StageOutcome<Input, Output> = {
    outputs: [],
    failures: [],
    skipped: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    cache_hits: 0,
    states: {},
  };

  const results = await mapWithConcurrency(options.items, options.concurrency, async (item) => {
    const lead_id = options.leadIdOf(item);
    const log = options.logger.child({ agent: agent.name, lead_id });
    const started = clock.now().getTime();
    const result = await agent.run(item, {
      runId: options.runId,
      model: options.model,
      logger: log,
      clock,
    });
    const duration_ms = clock.now().getTime() - started;
    if (result.status === 'ok') {
      log.info('lead.processed', { duration_ms, from_cache: result.fromCache === true, usage: result.usage });
    } else if (result.status === 'skipped') {
      log.info('lead.skipped', { duration_ms, reason: result.reason });
    } else {
      log.error('lead.failed', { duration_ms, error: result.error });
    }
    return { item, result };
  });

  for (const { item, result } of results) {
    const lead_id = options.leadIdOf(item);
    const company_name = options.companyNameOf(item);
    outcome.states[lead_id] = {
      status: result.status,
      idempotency_key: null,
      attempts: 1,
      error_code: result.status === 'failed' ? result.error.code : null,
      updated_at: clock.now().toISOString(),
    };
    if (result.status === 'ok') {
      outcome.outputs.push({ input: item, output: result.output });
      if (result.fromCache === true) outcome.cache_hits += 1;
      if (result.usage !== null) {
        outcome.usage.input_tokens += result.usage.input_tokens;
        outcome.usage.output_tokens += result.usage.output_tokens;
      }
    } else if (result.status === 'skipped') {
      outcome.skipped.push({ lead_id, company_name, reason: result.reason });
    } else {
      outcome.failures.push({
        lead_id,
        company_name,
        code: result.error.code,
        message: result.error.message,
      });
    }
  }
  return outcome;
}

/** Builds the manifest.json content for a single-agent stage run. */
export function stageManifest(input: {
  runId: RunId;
  agent: AgentName;
  promptVersion: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  states: Record<string, StageState>;
  attempted: number;
  succeeded: number;
}): RunManifest {
  return {
    schema_version: 1,
    run_id: input.runId,
    status:
      input.finishedAt === null
        ? 'running'
        : input.attempted > 0 && input.succeeded === 0 && Object.values(input.states).some((s) => s.status === 'failed')
          ? 'failed'
          : 'completed',
    agents: [input.agent],
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    input_files: [],
    model: input.model,
    prompt_versions: { [input.agent]: input.promptVersion },
    records: Object.fromEntries(
      Object.entries(input.states).map(([leadId, state]) => [leadId, { [input.agent]: state }]),
    ),
  };
}
