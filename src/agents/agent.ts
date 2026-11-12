import type { ZodType, ZodTypeDef } from 'zod';
import type { PipelineError } from '../infra/errors.js';
import type { Logger } from '../infra/logger.js';
import type { Clock } from '../ports/clock.js';
import type { LlmUsage } from '../ports/llm.js';
import type { AgentName, RunId } from '../schemas/primitives.js';

/** Everything an agent may use that is not its input. */
export interface RunContext {
  runId: RunId;
  /** Model ID from configuration; never hardcoded in an agent. */
  model: string;
  logger: Logger;
  clock: Clock;
}

export type AgentResult<Output> =
  | { status: 'ok'; output: Output; usage: LlmUsage | null; fromCache?: boolean }
  /** Not processed: already done (idempotency) or stopped by a gate. */
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: PipelineError };

/**
 * Contract every agent implements. Agents never call each other: the
 * orchestrator validates each output against `outputSchema` and passes it on
 * only if the hand-off gate allows it.
 */
export interface Agent<Input, Output> {
  readonly name: AgentName;
  /** Version of the prompt file, part of the idempotency key. */
  readonly promptVersion: string;
  readonly inputSchema: ZodType<Input, ZodTypeDef, unknown>;
  readonly outputSchema: ZodType<Output, ZodTypeDef, unknown>;
  run(input: Input, context: RunContext): Promise<AgentResult<Output>>;
}
