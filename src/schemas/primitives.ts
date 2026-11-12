import { z } from 'zod';

/** ISO-8601 timestamp with timezone, e.g. 2026-11-12T16:40:00Z. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SegmentSchema = z.enum([
  'transport',
  'logistics',
  'distribution',
  'fleet_intensive',
  'other',
]);
export type Segment = z.infer<typeof SegmentSchema>;

export const PrioritySchema = z.enum(['A', 'B', 'C', 'low']);
export type Priority = z.infer<typeof PrioritySchema>;

export const AgentNameSchema = z.enum(['minerador', 'pesquisador', 'copywriter']);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const LanguageSchema = z.enum(['pt', 'en']);
export type Language = z.infer<typeof LanguageSchema>;

/** Stable lead identifier. The only identifier for a company in this system. */
export const LeadIdSchema = z.string().regex(/^lead_[a-f0-9]{16}$/, 'invalid lead_id');
export type LeadId = z.infer<typeof LeadIdSchema>;

/** Unique run identifier: UTC timestamp plus random suffix. */
export const RunIdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{4}Z_[a-z0-9]{6}$/, 'invalid run_id');
export type RunId = z.infer<typeof RunIdSchema>;

export const FactIdSchema = z.string().regex(/^fact_[a-z0-9]{6,}$/, 'invalid fact_id');
export const ContactIdSchema = z.string().regex(/^contact_[a-z0-9]{6,}$/, 'invalid contact_id');
export const DraftIdSchema = z.string().regex(/^draft_[a-z0-9]{6,}$/, 'invalid draft_id');

export const SourceTypeSchema = z.enum([
  'official_site',
  'business_directory',
  'news',
  'government',
  'social',
  'import',
  'other',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/**
 * Where a piece of information came from. `url` is null only when an imported
 * row had no source URL; such a source cannot back a verified fact.
 */
export const SourceRefSchema = z
  .object({
    url: z.string().url().nullable(),
    source_name: z.string().min(1).nullable(),
    source_type: SourceTypeSchema,
    retrieved_at: IsoDateTimeSchema,
    /** Search provider that surfaced the source, e.g. "serper". Null for imports. */
    provider: z.string().min(1).nullable(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const FactKindSchema = z.enum(['verified', 'hypothesis']);
export type FactKind = z.infer<typeof FactKindSchema>;

/**
 * A single material claim about a company. Verified facts must carry at least
 * one source with a URL; hypotheses are AI-generated and must never be
 * presented as confirmed.
 */
export const FactSchema = z
  .object({
    fact_id: FactIdSchema,
    statement: z.string().min(1),
    kind: FactKindSchema,
    confidence: ConfidenceSchema,
    sources: z.array(SourceRefSchema),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (fact.kind === 'verified' && !fact.sources.some((s) => s.url !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'a verified fact needs at least one source with a URL',
      });
    }
  });
export type Fact = z.infer<typeof FactSchema>;

/** Decision-maker roles targeted by outreach (CLAUDE.md section 4). */
export const PersonaSchema = z.enum([
  'managing_director',
  'owner',
  'operations_director',
  'fleet_manager',
  'transport_manager',
  'logistics_manager',
  'finance_director',
  'procurement_manager',
]);
export type Persona = z.infer<typeof PersonaSchema>;

export const ContactChannelSchema = z.enum([
  'email',
  'phone',
  'whatsapp',
  'linkedin',
  'website_form',
  'other',
]);
export type ContactChannel = z.infer<typeof ContactChannelSchema>;

/**
 * A publicly available business contact attached to a lead. Named people are
 * recorded only when publicly sourced; nothing here may be inferred or invented.
 */
export const PublicContactSchema = z
  .object({
    contact_id: ContactIdSchema,
    channel: ContactChannelSchema,
    value: z.string().min(1),
    scope: z.enum(['corporate', 'named_person']),
    person_name: z.string().min(1).nullable(),
    role_title: z.string().min(1).nullable(),
    persona: PersonaSchema.nullable(),
    source: SourceRefSchema,
    confidence: ConfidenceSchema,
  })
  .strict()
  .superRefine((contact, ctx) => {
    if (contact.scope === 'named_person' && contact.person_name === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['person_name'],
        message: 'a named_person contact needs person_name',
      });
    }
  });
export type PublicContact = z.infer<typeof PublicContactSchema>;

/** Processing metadata recorded on every agent output. */
export const ProvenanceSchema = z
  .object({
    run_id: RunIdSchema,
    agent: AgentNameSchema,
    model: z.string().min(1).nullable(),
    prompt_version: z.string().min(1).nullable(),
    processed_at: IsoDateTimeSchema,
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;
