import { PipelineError, toPipelineError } from '../../infra/errors.js';
import { sha256Hex } from '../../infra/hash.js';
import type { RetryOptions } from '../../infra/retry.js';
import type { LlmClient } from '../../ports/llm.js';
import { LeadCandidateSchema } from '../../schemas/candidate.js';
import type { LeadCandidate } from '../../schemas/candidate.js';
import { QualifiedLeadSchema } from '../../schemas/lead.js';
import type { QualifiedLead } from '../../schemas/lead.js';
import type { ScoringConfig } from '../../schemas/settings.js';
import type { Agent, AgentResult } from '../agent.js';
import { callStructured } from '../structured-call.js';
import type { JsonCache } from '../structured-call.js';
import { assembleQualifiedLead } from './assemble.js';
import { buildMineradorInput } from './build-input.js';
import {
  MINERADOR_JSON_SCHEMA,
  MINERADOR_SCHEMA_NAME,
  MineradorModelOutputSchema,
} from './model-output.js';

const MAX_OUTPUT_TOKENS = 2_000;

export type AssessmentCache = JsonCache;

export interface MineradorDeps {
  llm: LlmClient;
  scoring: ScoringConfig;
  /** Content of prompts/01_minerador.md. */
  prompt: string;
  cache?: JsonCache;
  /** When true, cached assessments are ignored and replaced. */
  force?: boolean;
  retry?: Partial<RetryOptions>;
}

/** Changes whenever the prompt text changes, which invalidates cached results. */
export function promptVersionOf(prompt: string): string {
  return `sha-${sha256Hex(prompt).slice(0, 12)}`;
}

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Agent 1. Classifies one company and proposes ICP scores from the collected
 * data only. It performs no web research and invents nothing: facts, sources,
 * contacts, arithmetic and the qualification decision are produced by code.
 */
export function createMineradorAgent(deps: MineradorDeps): Agent<LeadCandidate, QualifiedLead> {
  const promptVersion = promptVersionOf(deps.prompt);

  return {
    name: 'minerador',
    promptVersion,
    inputSchema: LeadCandidateSchema,
    outputSchema: QualifiedLeadSchema,

    async run(input, context): Promise<AgentResult<QualifiedLead>> {
      const candidate = LeadCandidateSchema.safeParse(input);
      if (!candidate.success) {
        return {
          status: 'failed',
          error: new PipelineError({
            code: 'input_validation',
            message: 'Invalid lead candidate',
            context: { problems: issuesOf(candidate.error) },
          }),
        };
      }
      try {
        const assessment = await callStructured({
          llm: deps.llm,
          model: context.model,
          system: deps.prompt,
          user: buildMineradorInput(candidate.data, deps.scoring),
          schemaName: MINERADOR_SCHEMA_NAME,
          jsonSchema: MINERADOR_JSON_SCHEMA,
          schema: MineradorModelOutputSchema,
          maxTokens: MAX_OUTPUT_TOKENS,
          promptVersion,
          logger: context.logger,
          leadId: candidate.data.lead_id,
          cache: deps.cache,
          force: deps.force,
          retry: deps.retry,
        });
        const now = context.clock.now().toISOString();
        const { lead, dropped_evidence } = assembleQualifiedLead(
          candidate.data,
          assessment.output,
          deps.scoring,
          {
            now,
            provenance: {
              run_id: context.runId,
              agent: 'minerador',
              model: context.model,
              prompt_version: promptVersion,
              processed_at: now,
            },
          },
        );
        if (dropped_evidence.length > 0) {
          context.logger.warn('evidence.dropped', {
            lead_id: lead.lead_id,
            count: dropped_evidence.length,
          });
        }
        const validated = QualifiedLeadSchema.safeParse(lead);
        if (!validated.success) {
          return {
            status: 'failed',
            error: new PipelineError({
              code: 'internal',
              message: 'Assembled lead failed schema validation',
              context: { lead_id: lead.lead_id, problems: issuesOf(validated.error) },
            }),
          };
        }
        return {
          status: 'ok',
          output: validated.data,
          usage: assessment.usage,
          fromCache: assessment.fromCache,
        };
      } catch (error) {
        return { status: 'failed', error: toPipelineError(error) };
      }
    },
  };
}
