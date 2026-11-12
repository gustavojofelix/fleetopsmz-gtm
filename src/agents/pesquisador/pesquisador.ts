import { PipelineError, toPipelineError } from '../../infra/errors.js';
import type { RetryOptions } from '../../infra/retry.js';
import type { LlmClient } from '../../ports/llm.js';
import { ResearchDossierSchema } from '../../schemas/dossier.js';
import type { ResearchDossier } from '../../schemas/dossier.js';
import { QualifiedLeadSchema } from '../../schemas/lead.js';
import type { QualifiedLead } from '../../schemas/lead.js';
import type { SearchResult } from '../../schemas/search.js';
import type { GeographyConfig, ScoringConfig } from '../../schemas/settings.js';
import type { SearchService } from '../../tools/search.js';
import type { Agent, AgentResult } from '../agent.js';
import { promptVersionOf } from '../minerador/minerador.js';
import { callStructured } from '../structured-call.js';
import type { JsonCache } from '../structured-call.js';
import { assembleDossier } from './assemble.js';
import {
  PESQUISADOR_JSON_SCHEMA,
  PESQUISADOR_SCHEMA_NAME,
  PesquisadorModelOutputSchema,
} from './model-output.js';
import {
  RESULTS_PER_QUERY,
  SEARCH_COUNTRY,
  buildPesquisadorInput,
  buildResearchQueries,
  numberResults,
} from './research-input.js';

const MAX_OUTPUT_TOKENS = 4_000;

export interface PesquisadorDeps {
  llm: LlmClient;
  search: SearchService;
  scoring: ScoringConfig;
  geography: GeographyConfig;
  /** Content of prompts/02_pesquisador.md. */
  prompt: string;
  cache?: JsonCache;
  force?: boolean;
  retry?: Partial<RetryOptions>;
}

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Agent 2. Researches one qualified company through the search provider and
 * produces a dossier. It reads search results only (titles, links, snippets):
 * it does not open pages, log in anywhere or bypass any access control.
 */
export function createPesquisadorAgent(deps: PesquisadorDeps): Agent<QualifiedLead, ResearchDossier> {
  const promptVersion = promptVersionOf(deps.prompt);

  return {
    name: 'pesquisador',
    promptVersion,
    inputSchema: QualifiedLeadSchema,
    outputSchema: ResearchDossierSchema,

    async run(input, context): Promise<AgentResult<ResearchDossier>> {
      const parsedLead = QualifiedLeadSchema.safeParse(input);
      if (!parsedLead.success) {
        return {
          status: 'failed',
          error: new PipelineError({
            code: 'input_validation',
            message: 'Invalid qualified lead',
            context: { problems: issuesOf(parsedLead.error) },
          }),
        };
      }
      const lead = parsedLead.data;
      try {
        // 1. Search. One failing query does not stop the others.
        const batches: SearchResult[][] = [];
        const searches: ResearchDossier['searches'] = [];
        let lastError: unknown;
        for (const query of buildResearchQueries(lead)) {
          try {
            const outcome = await deps.search.search(query, {
              limit: RESULTS_PER_QUERY,
              country: SEARCH_COUNTRY,
              language: 'pt',
            });
            batches.push(outcome.results);
            searches.push({
              query,
              provider: deps.search.providerName,
              result_count: outcome.results.length,
              retrieved_at: outcome.results[0]?.retrieved_at ?? context.clock.now().toISOString(),
            });
          } catch (error) {
            lastError = error;
            context.logger.warn('search.failed', { lead_id: lead.lead_id, error });
          }
        }
        if (searches.length === 0) throw toPipelineError(lastError, 'provider_transient');
        const results = numberResults(batches);

        // 2. Read the results. Skipped when there is nothing to read.
        const reading =
          results.length === 0
            ? null
            : await callStructured({
                llm: deps.llm,
                model: context.model,
                system: deps.prompt,
                user: buildPesquisadorInput(lead, results, deps.scoring),
                schemaName: PESQUISADOR_SCHEMA_NAME,
                jsonSchema: PESQUISADOR_JSON_SCHEMA,
                schema: PesquisadorModelOutputSchema,
                maxTokens: MAX_OUTPUT_TOKENS,
                promptVersion,
                logger: context.logger,
                leadId: lead.lead_id,
                cache: deps.cache,
                force: deps.force,
                retry: deps.retry,
              });

        // 3. Ground and assemble.
        const now = context.clock.now().toISOString();
        const { dossier, dropped } = assembleDossier(
          lead,
          results,
          reading?.output ?? null,
          { scoring: deps.scoring, geography: deps.geography },
          {
            now,
            searches,
            provenance: {
              run_id: context.runId,
              agent: 'pesquisador',
              model: reading === null ? null : context.model,
              prompt_version: promptVersion,
              processed_at: now,
            },
          },
        );
        if (dropped.facts > 0 || dropped.contacts > 0) {
          context.logger.warn('research.ungrounded_dropped', { lead_id: lead.lead_id, ...dropped });
        }
        const validated = ResearchDossierSchema.safeParse(dossier);
        if (!validated.success) {
          return {
            status: 'failed',
            error: new PipelineError({
              code: 'internal',
              message: 'Assembled dossier failed schema validation',
              context: { lead_id: lead.lead_id, problems: issuesOf(validated.error) },
            }),
          };
        }
        return {
          status: 'ok',
          output: validated.data,
          usage: reading?.usage ?? null,
          fromCache: reading?.fromCache ?? false,
        };
      } catch (error) {
        return { status: 'failed', error: toPipelineError(error) };
      }
    },
  };
}
