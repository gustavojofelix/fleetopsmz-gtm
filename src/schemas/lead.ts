import { z } from 'zod';
import {
  ConfidenceSchema,
  FactIdSchema,
  FactSchema,
  IsoDateTimeSchema,
  LeadIdSchema,
  PrioritySchema,
  ProvenanceSchema,
  PublicContactSchema,
  RunIdSchema,
  SegmentSchema,
  SourceRefSchema,
} from './primitives.js';

/** The eight ICP criteria of the 100-point model (CLAUDE.md section 9). */
export const IcpCriterionKeySchema = z.enum([
  'segment_relevance',
  'fleet_activity',
  'operational_complexity',
  'geographic_relevance',
  'recurring_transport',
  'cost_control_need',
  'contact_availability',
  'digital_maturity',
]);
export type IcpCriterionKey = z.infer<typeof IcpCriterionKeySchema>;

export const ScoreBasisSchema = z.enum(['evidence', 'inference', 'unknown']);
export type ScoreBasis = z.infer<typeof ScoreBasisSchema>;

export const IcpCriterionScoreSchema = z
  .object({
    key: IcpCriterionKeySchema,
    points: z.number().int().min(0),
    max: z.number().int().positive(),
    /** What the points rest on. "unknown" means no information was found. */
    basis: ScoreBasisSchema,
    rationale: z.string().min(1),
    fact_refs: z.array(FactIdSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.points > c.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: `points exceed the maximum of ${c.max}`,
      });
    }
    if (c.basis === 'evidence' && c.fact_refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fact_refs'],
        message: 'an evidence-based score must reference at least one fact',
      });
    }
    if (c.basis === 'unknown' && c.points !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: 'an unknown criterion carries 0 points; uncertainty is tracked by coverage',
      });
    }
  });
export type IcpCriterionScore = z.infer<typeof IcpCriterionScoreSchema>;

/**
 * Full ICP assessment. `coverage` is the share of available points (0 to 1)
 * belonging to criteria whose basis is not "unknown". Low coverage sends a
 * lead to manual review instead of rejecting it for missing information.
 */
export const IcpAssessmentSchema = z
  .object({
    criteria: z.array(IcpCriterionScoreSchema),
    score: z.number().int().min(0).max(100),
    coverage: z.number().min(0).max(1),
    priority: PrioritySchema,
  })
  .strict()
  .superRefine((icp, ctx) => {
    const expected = IcpCriterionKeySchema.options;
    const seen = new Set(icp.criteria.map((c) => c.key));
    if (icp.criteria.length !== expected.length || seen.size !== expected.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: 'criteria must contain each of the eight ICP criteria exactly once',
      });
    }
    const sum = icp.criteria.reduce((total, c) => total + c.points, 0);
    if (sum !== icp.score) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['score'],
        message: `score ${icp.score} does not equal the sum of criterion points (${sum})`,
      });
    }
  });
export type IcpAssessment = z.infer<typeof IcpAssessmentSchema>;

export const QualificationStatusSchema = z.enum([
  /** Priority A or B with adequate coverage: proceeds to Agent 2 automatically. */
  'qualified',
  /** Priority C, or too little information: held until a person promotes it. */
  'manual_review',
  /** Below 40 with adequate coverage: archived, never deleted. */
  'low_priority',
  /** Resolved to an existing lead. */
  'duplicate',
]);
export type QualificationStatus = z.infer<typeof QualificationStatusSchema>;

export const ReviewReasonSchema = z.enum([
  'priority_c',
  'insufficient_information',
  'possible_duplicate',
  'other',
]);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

/**
 * The primary company record: Agent 1 output and Agent 2 input.
 * One record per company, with its business contacts attached.
 */
export const QualifiedLeadSchema = z
  .object({
    lead_id: LeadIdSchema,
    company_name: z.string().min(1),
    normalized_name: z.string().min(1),
    website: z.string().url().nullable(),
    business_segment: SegmentSchema,
    sub_segment: z.string().min(1).nullable(),
    city: z.string().min(1).nullable(),
    province: z.string().min(1).nullable(),
    country: z.string().min(1),
    business_description: z.string().min(1).nullable(),
    fleet_evidence: z.array(FactSchema),
    public_contacts: z.array(PublicContactSchema),
    source_urls: z.array(SourceRefSchema),
    icp: IcpAssessmentSchema,
    qualification_status: QualificationStatusSchema,
    review_reason: ReviewReasonSchema.nullable(),
    duplicate_of: LeadIdSchema.nullable(),
    merged_raw_ids: z.array(z.string().min(1)),
    confidence: ConfidenceSchema,
    provenance: ProvenanceSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((lead, ctx) => {
    if (lead.qualification_status === 'manual_review' && lead.review_reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review_reason'],
        message: 'manual_review needs a review_reason',
      });
    }
    if (lead.qualification_status === 'duplicate' && lead.duplicate_of === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicate_of'],
        message: 'a duplicate needs duplicate_of',
      });
    }
    if (lead.duplicate_of === lead.lead_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicate_of'],
        message: 'a lead cannot be a duplicate of itself',
      });
    }
  });
export type QualifiedLead = z.infer<typeof QualifiedLeadSchema>;

/** Keys used to recognise the same company across runs. */
export const IdentityKeySchema = z
  .object({
    /**
     * domain, phone and name_city are strong keys. A domain comes from the
     * company's own website or email address, so the two match each other.
     * name_only is used when a record has no city: it matches only other
     * records that also have no city.
     */
    type: z.enum(['domain', 'phone', 'name_city', 'name_only']),
    value: z.string().min(1),
  })
  .strict();
export type IdentityKey = z.infer<typeof IdentityKeySchema>;

export const LeadRegistryEntrySchema = z
  .object({
    lead_id: LeadIdSchema,
    normalized_name: z.string().min(1),
    country: z.string().min(1),
    keys: z.array(IdentityKeySchema),
    first_seen_run: RunIdSchema,
    last_seen_run: RunIdSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();
export type LeadRegistryEntry = z.infer<typeof LeadRegistryEntrySchema>;

/** Persistent identity index that keeps lead_id stable across runs. */
export const LeadRegistrySchema = z
  .object({
    schema_version: z.literal(1),
    updated_at: IsoDateTimeSchema.nullable(),
    entries: z.array(LeadRegistryEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const ids = registry.entries.map((e) => e.lead_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries'],
        message: 'lead_id values in the registry must be unique',
      });
    }
  });
export type LeadRegistry = z.infer<typeof LeadRegistrySchema>;

/** A manual promotion or demotion recorded by a person in data/reviews/promotions.csv. */
export const PromotionRecordSchema = z
  .object({
    lead_id: LeadIdSchema,
    decision: z.enum(['promote', 'archive', 'keep_in_review']),
    reviewer: z.string().min(1),
    decided_at: IsoDateTimeSchema,
    note: z.string().nullable(),
  })
  .strict();
export type PromotionRecord = z.infer<typeof PromotionRecordSchema>;
