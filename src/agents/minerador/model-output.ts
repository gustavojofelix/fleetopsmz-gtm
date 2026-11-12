import { z } from 'zod';
import { ScoreBasisSchema } from '../../schemas/lead.js';
import { SegmentSchema } from '../../schemas/primitives.js';

/**
 * Criteria the model scores. geographic_relevance and contact_availability are
 * computed by code from configuration and collected data.
 */
export const MODEL_SCORED_CRITERIA = [
  'segment_relevance',
  'fleet_activity',
  'operational_complexity',
  'recurring_transport',
  'cost_control_need',
  'digital_maturity',
] as const;
export type ModelScoredCriterion = (typeof MODEL_SCORED_CRITERIA)[number];

/** Which input field an evidence statement restates. */
export const EVIDENCE_FIELDS = [
  'business_description',
  'business_category',
  'company_name',
  'website',
] as const;

export const MineradorModelOutputSchema = z
  .object({
    business_segment: SegmentSchema,
    sub_segment: z.string().min(1).nullable(),
    evidence: z
      .array(
        z
          .object({
            id: z.string().regex(/^e\d+$/),
            statement: z.string().min(1),
            supported_by: z.enum(EVIDENCE_FIELDS),
          })
          .strict(),
      )
      .max(12),
    criteria: z.array(
      z
        .object({
          key: z.enum(MODEL_SCORED_CRITERIA),
          points: z.number(),
          basis: ScoreBasisSchema,
          rationale: z.string().min(1),
          evidence_ids: z.array(z.string()),
        })
        .strict(),
    ),
    notes: z.string().nullable(),
  })
  .strict();
export type MineradorModelOutput = z.infer<typeof MineradorModelOutputSchema>;

export const MINERADOR_SCHEMA_NAME = 'minerador_assessment';

/**
 * JSON Schema sent to the model as the tool input schema. Enumerations are
 * taken from the Zod schemas above so the two definitions cannot drift apart.
 */
export const MINERADOR_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['business_segment', 'sub_segment', 'evidence', 'criteria', 'notes'],
  properties: {
    business_segment: { type: 'string', enum: [...SegmentSchema.options] },
    sub_segment: {
      type: ['string', 'null'],
      description: 'Short snake_case label such as road_freight, or null if unclear.',
    },
    evidence: {
      type: 'array',
      maxItems: 12,
      description: 'Statements that restate what the input says. Never add outside knowledge.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement', 'supported_by'],
        properties: {
          id: { type: 'string', pattern: '^e\\d+$', description: 'e1, e2, ...' },
          statement: { type: 'string' },
          supported_by: { type: 'string', enum: [...EVIDENCE_FIELDS] },
        },
      },
    },
    criteria: {
      type: 'array',
      description: 'One entry for each of the six criteria.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'points', 'basis', 'rationale', 'evidence_ids'],
        properties: {
          key: { type: 'string', enum: [...MODEL_SCORED_CRITERIA] },
          points: { type: 'number' },
          basis: { type: 'string', enum: [...ScoreBasisSchema.options] },
          rationale: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notes: { type: ['string', 'null'] },
  },
};
