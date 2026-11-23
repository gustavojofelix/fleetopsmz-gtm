import { commercialDraftsEnabled } from '../../domain/capability-gate.js';
import { canDraftOutreach, usableFacts } from '../../domain/gates.js';
import { senderProblems } from '../../config/project-config.js';
import { PipelineError, toPipelineError } from '../../infra/errors.js';
import { shortHash } from '../../infra/hash.js';
import type { RetryOptions } from '../../infra/retry.js';
import type { LlmClient } from '../../ports/llm.js';
import type { CapabilityRegistry } from '../../schemas/capability.js';
import { ResearchDossierSchema } from '../../schemas/dossier.js';
import type { ResearchDossier } from '../../schemas/dossier.js';
import { OutreachPackageSchema } from '../../schemas/outreach.js';
import type { DraftType, OutreachDraft, OutreachPackage } from '../../schemas/outreach.js';
import type { OutreachConfig } from '../../schemas/settings.js';
import type { Agent, AgentResult } from '../agent.js';
import { promptVersionOf } from '../minerador/minerador.js';
import { callStructured } from '../structured-call.js';
import type { JsonCache } from '../structured-call.js';
import {
  COPYWRITER_JSON_SCHEMA,
  COPYWRITER_SCHEMA_NAME,
  CopywriterModelOutputSchema,
} from './model-output.js';
import { PERSONA_LABELS, buildTargets } from './targets.js';
import type { DraftTarget } from './targets.js';
import { BODY_LIMITS, checkCopy, listProblems } from './validate.js';

/** Includes the model's thinking, which is on by default on current models. */
const MAX_OUTPUT_TOKENS = 16_000;

/** The only description of the product allowed while no capability is verified. */
export const NEUTRAL_PRODUCT_DESCRIPTION = {
  pt: 'O FleetOps MZ é uma plataforma de gestão de frotas e operações de transporte, desenvolvida para empresas em Moçambique.',
  en: 'FleetOps MZ is a fleet and transport operations management platform built for companies in Mozambique.',
} as const;

export interface CopywriterDeps {
  llm: LlmClient;
  registry: CapabilityRegistry;
  outreach: OutreachConfig;
  /** Content of prompts/03_copywriter.md. */
  prompt: string;
  cache?: JsonCache;
  force?: boolean;
  retry?: Partial<RetryOptions>;
}

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export interface CopywriterInput {
  text: string;
  /** Short id given to the model (v1) to the dossier's fact_id. */
  factIds: Map<string, string>;
}

/** Builds the user message. Only verified, non-low-confidence facts are offered. */
export function buildCopywriterInput(
  dossier: ResearchDossier,
  targets: readonly DraftTarget[],
  registry: CapabilityRegistry,
  outreach: OutreachConfig,
  draftType: DraftType,
): CopywriterInput {
  const language = dossier.language;
  const facts = usableFacts(dossier);
  const factIds = new Map(facts.map((fact, index) => [`v${index + 1}`, fact.fact_id]));
  const capabilities =
    draftType === 'commercial'
      ? registry.capabilities
          .filter((c) => c.status === 'implemented' || c.status === 'partially_implemented')
          .map((c) => ({
            key: c.key,
            name: language === 'pt' ? c.name_pt : c.name_en,
            status: c.status,
            limitations_to_state: c.limitations,
          }))
      : [];
  const sections = [
    `<mode>${draftType}</mode>`,
    `<language>${language}</language>`,
    '<company>',
    JSON.stringify(
      {
        company_name: dossier.lead.company_name,
        city: dossier.lead.city,
        business_segment: dossier.lead.business_segment,
      },
      null,
      2,
    ),
    '</company>',
    '<verified_facts>',
    JSON.stringify(
      facts.map((fact, index) => ({ id: `v${index + 1}`, statement: fact.statement })),
      null,
      2,
    ),
    '</verified_facts>',
    '<topics_to_explore>',
    JSON.stringify(dossier.challenge_hypotheses.map((h) => h.statement), null, 2),
    '</topics_to_explore>',
    '<product_description>',
    NEUTRAL_PRODUCT_DESCRIPTION[language],
    '</product_description>',
    '<capabilities>',
    JSON.stringify(capabilities, null, 2),
    '</capabilities>',
    '<sender>',
    JSON.stringify(
      { name: outreach.sender.name, role: outreach.sender.role, company: outreach.sender.company },
      null,
      2,
    ),
    '</sender>',
    '<targets>',
    JSON.stringify(
      targets.map((target) => ({
        target_id: target.target_id,
        channel: target.channel,
        recipient_role: PERSONA_LABELS[target.persona][language],
        recipient_name: target.addressed_to,
        recipient_title: target.role_title,
        max_body_characters: BODY_LIMITS[target.channel],
      })),
      null,
      2,
    ),
    '</targets>',
  ];
  return { text: sections.join('\n'), factIds };
}

/**
 * Agent 3. Writes outreach drafts for one researched company. Drafts are only
 * ever produced for human review: this agent cannot approve or send anything.
 *
 * While no capability in the registry is marked implemented, it writes neutral
 * institutional introductions that make no product capability claim. Once at
 * least one is, it writes commercial drafts whose every capability reference
 * must pass the capability gate.
 */
export function createCopywriterAgent(deps: CopywriterDeps): Agent<ResearchDossier, OutreachPackage> {
  const promptVersion = promptVersionOf(deps.prompt);

  return {
    name: 'copywriter',
    promptVersion,
    inputSchema: ResearchDossierSchema,
    outputSchema: OutreachPackageSchema,

    async run(input, context): Promise<AgentResult<OutreachPackage>> {
      const parsed = ResearchDossierSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: 'failed',
          error: new PipelineError({
            code: 'input_validation',
            message: 'Invalid research dossier',
            context: { problems: issuesOf(parsed.error) },
          }),
        };
      }
      const dossier = parsed.data;
      const sender = senderProblems(deps.outreach);
      if (sender.length > 0) {
        return {
          status: 'failed',
          error: new PipelineError({
            code: 'config',
            message: `config/outreach.json is incomplete: ${sender.join('; ')}`,
          }),
        };
      }
      const gate = canDraftOutreach(dossier);
      if (!gate.allowed) return { status: 'skipped', reason: gate.reasons.join('; ') };
      const targets = buildTargets(dossier, deps.outreach);
      if (targets.length === 0) return { status: 'skipped', reason: 'no usable contact channel' };

      const draftType: DraftType = commercialDraftsEnabled(deps.registry)
        ? 'commercial'
        : 'institutional_intro';
      const request = buildCopywriterInput(dossier, targets, deps.registry, deps.outreach, draftType);
      const checkContext = {
        targets,
        allowedFactIds: new Set(request.factIds.keys()),
        registry: deps.registry,
        draftType,
      };

      try {
        const written = await callStructured({
          llm: deps.llm,
          model: context.model,
          system: deps.prompt,
          user: request.text,
          schemaName: COPYWRITER_SCHEMA_NAME,
          jsonSchema: COPYWRITER_JSON_SCHEMA,
          schema: CopywriterModelOutputSchema,
          maxTokens: MAX_OUTPUT_TOKENS,
          promptVersion,
          logger: context.logger,
          leadId: dossier.lead_id,
          cache: deps.cache,
          force: deps.force,
          retry: deps.retry,
          check: (output) => listProblems(checkCopy(output, checkContext), output),
          // Drafts that still fail after the repair are dropped one by one below.
          acceptAfterRepair: true,
        });

        const checks = checkCopy(written.output, checkContext);
        const rejected = checks.filter((check) => check.problems.length > 0);
        if (rejected.length > 0) {
          context.logger.warn('drafts.rejected', {
            lead_id: dossier.lead_id,
            count: rejected.length,
            problems: rejected.flatMap((c) => c.problems.map((p) => `${c.target.target_id}: ${p}`)),
          });
        }

        const drafts: OutreachDraft[] = [];
        for (const check of checks) {
          if (check.draft === null || check.problems.length > 0) continue;
          const { target, draft } = check;
          drafts.push({
            draft_id: `draft_${shortHash(
              [dossier.lead_id, target.persona, target.channel, target.addressed_to ?? '', draft.body],
              12,
            )}`,
            draft_type: draftType,
            persona: target.persona,
            addressed_to: target.addressed_to,
            contact_id: target.contact_id,
            channel: target.channel,
            language: dossier.language,
            subject: target.channel === 'email' ? draft.subject : null,
            body: draft.body.trim(),
            call_to_action: draft.call_to_action.trim(),
            opt_out_line: draft.opt_out_line.trim(),
            fact_refs: draft.fact_ids
              .map((id) => request.factIds.get(id))
              .filter((id): id is string => id !== undefined),
            capability_refs: draftType === 'commercial' ? draft.capability_keys : [],
            requires_capability_approval: check.requires_capability_approval,
            review_flags: check.flags,
          });
        }
        if (drafts.length === 0) {
          return {
            status: 'failed',
            error: new PipelineError({
              code: 'grounding_violation',
              message: 'Every draft failed the grounding or capability checks',
              context: {
                lead_id: dossier.lead_id,
                problems: rejected.flatMap((c) => c.problems.map((p) => `${c.target.target_id}: ${p}`)),
              },
            }),
          };
        }

        const now = context.clock.now().toISOString();
        const validated = OutreachPackageSchema.safeParse({
          lead_id: dossier.lead_id,
          drafts,
          approval: { status: 'pending_human_review' },
          provenance: {
            run_id: context.runId,
            agent: 'copywriter',
            model: context.model,
            prompt_version: promptVersion,
            processed_at: now,
          },
        });
        if (!validated.success) {
          return {
            status: 'failed',
            error: new PipelineError({
              code: 'internal',
              message: 'Assembled outreach package failed schema validation',
              context: { lead_id: dossier.lead_id, problems: issuesOf(validated.error) },
            }),
          };
        }
        return {
          status: 'ok',
          output: validated.data,
          usage: written.usage,
          fromCache: written.fromCache,
        };
      } catch (error) {
        return { status: 'failed', error: toPipelineError(error) };
      }
    },
  };
}
