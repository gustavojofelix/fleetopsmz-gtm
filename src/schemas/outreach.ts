import { z } from 'zod';
import {
  ContactIdSchema,
  DraftIdSchema,
  FactIdSchema,
  IsoDateTimeSchema,
  LanguageSchema,
  LeadIdSchema,
  PersonaSchema,
  ProvenanceSchema,
} from './primitives.js';

export const OutreachChannelSchema = z.enum(['email', 'linkedin', 'whatsapp']);
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>;

/**
 * institutional_intro: neutral introduction with no product capability claims.
 * commercial: mentions product capabilities, every one of which must pass the
 * capability gate (see domain/capability-gate.ts).
 */
export const DraftTypeSchema = z.enum(['institutional_intro', 'commercial']);
export type DraftType = z.infer<typeof DraftTypeSchema>;

const CapabilityKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'invalid capability key');

export const OutreachDraftSchema = z
  .object({
    draft_id: DraftIdSchema,
    draft_type: DraftTypeSchema,
    persona: PersonaSchema,
    /** A person's name only when the dossier holds it from a public source. */
    addressed_to: z.string().min(1).nullable(),
    /** The public contact this draft is meant for, when one exists. */
    contact_id: ContactIdSchema.nullable(),
    channel: OutreachChannelSchema,
    language: LanguageSchema,
    subject: z.string().min(1).nullable(),
    body: z.string().min(1),
    call_to_action: z.string().min(1),
    opt_out_line: z.string().min(1),
    /** Dossier facts the message relies on. */
    fact_refs: z.array(FactIdSchema),
    /** Registry capabilities the message mentions. */
    capability_refs: z.array(CapabilityKeySchema),
    /** True when a partially implemented capability is mentioned. */
    requires_capability_approval: z.boolean(),
    /** Points the reviewer must check before approving, found by automatic checks. */
    review_flags: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (draft.channel === 'email' && draft.subject === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject'],
        message: 'an email draft needs a subject',
      });
    }
    if (draft.draft_type === 'institutional_intro' && draft.capability_refs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability_refs'],
        message: 'an institutional introduction must not reference product capabilities',
      });
    }
    if (draft.draft_type === 'commercial' && draft.capability_refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability_refs'],
        message: 'a commercial draft must reference at least one capability',
      });
    }
  });
export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;

/**
 * Agent 3 output. The agent can only ever emit drafts awaiting human review:
 * approval decisions are recorded separately by a person, and nothing in this
 * system sends a message.
 */
export const OutreachPackageSchema = z
  .object({
    lead_id: LeadIdSchema,
    drafts: z.array(OutreachDraftSchema).min(1),
    approval: z.object({ status: z.literal('pending_human_review') }).strict(),
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((pkg, ctx) => {
    const ids = pkg.drafts.map((d) => d.draft_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['drafts'],
        message: 'draft_id values must be unique within a package',
      });
    }
  });
export type OutreachPackage = z.infer<typeof OutreachPackageSchema>;

/** A human decision on one draft, recorded in data/reviews/approvals.csv. */
export const ApprovalRecordSchema = z
  .object({
    draft_id: DraftIdSchema,
    lead_id: LeadIdSchema,
    decision: z.enum(['approved', 'rejected', 'changes_requested']),
    reviewer: z.string().min(1),
    decided_at: IsoDateTimeSchema,
    note: z.string().nullable(),
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
