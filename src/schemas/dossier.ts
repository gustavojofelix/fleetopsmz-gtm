import { z } from 'zod';
import { QualifiedLeadSchema } from './lead.js';
import {
  ConfidenceSchema,
  FactSchema,
  IsoDateTimeSchema,
  LanguageSchema,
  LeadIdSchema,
  ProvenanceSchema,
} from './primitives.js';

export const ResearchStatusSchema = z.enum(['complete', 'partial', 'insufficient']);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

/**
 * Agent 2 output and Agent 3 input. Verified facts and hypotheses live in
 * separate lists so a hypothesis can never be read as a confirmed fact.
 * Decision-makers are the `named_person` entries of `lead.public_contacts`.
 */
export const ResearchDossierSchema = z
  .object({
    lead_id: LeadIdSchema,
    /** Snapshot of the lead after research, with contacts and ICP re-scored. */
    lead: QualifiedLeadSchema,
    identity_verified: z.boolean(),
    identity_evidence: z.array(FactSchema),
    facts: z.array(FactSchema),
    challenge_hypotheses: z.array(FactSchema),
    /** Software or tools the company is publicly seen to use, if any. */
    current_tools_observed: z.array(FactSchema),
    language: LanguageSchema,
    /** Searches run for this dossier, for audit. */
    searches: z.array(
      z
        .object({
          query: z.string().min(1),
          provider: z.string().min(1),
          result_count: z.number().int().min(0),
          retrieved_at: IsoDateTimeSchema,
        })
        .strict(),
    ),
    research_status: ResearchStatusSchema,
    recommended_next_action: z.string().min(1),
    confidence: ConfidenceSchema,
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((dossier, ctx) => {
    if (dossier.lead.lead_id !== dossier.lead_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lead', 'lead_id'],
        message: 'lead snapshot does not match the dossier lead_id',
      });
    }
    dossier.facts.forEach((fact, index) => {
      if (fact.kind !== 'verified') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['facts', index, 'kind'],
          message: 'facts may contain verified facts only',
        });
      }
    });
    dossier.challenge_hypotheses.forEach((fact, index) => {
      if (fact.kind !== 'hypothesis') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['challenge_hypotheses', index, 'kind'],
          message: 'challenge_hypotheses may contain hypotheses only',
        });
      }
    });
    if (
      dossier.identity_verified &&
      !dossier.identity_evidence.some((fact) => fact.kind === 'verified')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity_evidence'],
        message: 'identity_verified needs at least one verified identity fact',
      });
    }
  });
export type ResearchDossier = z.infer<typeof ResearchDossierSchema>;
