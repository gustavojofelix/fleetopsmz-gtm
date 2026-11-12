import { z } from 'zod';
import { ScoreBasisSchema } from '../../schemas/lead.js';
import { LanguageSchema, PersonaSchema } from '../../schemas/primitives.js';
import { MODEL_SCORED_CRITERIA } from '../minerador/model-output.js';

export const FACT_CATEGORIES = ['identity', 'fleet', 'activity', 'location', 'tools', 'other'] as const;

/** The operational challenges to investigate (CLAUDE.md section 5). */
export const PROBLEM_KEYS = [
  'operational_visibility',
  'manual_trip_tracking',
  'fragmented_information',
  'fuel_control',
  'maintenance_costs',
  'trip_profitability',
  'driver_vehicle_coordination',
  'spreadsheets_and_paper',
  'management_reporting',
  'process_integration',
] as const;

export const RESEARCH_CONTACT_CHANNELS = ['email', 'phone', 'whatsapp', 'linkedin', 'website_form'] as const;

const ResultId = z.string().regex(/^r\d+$/);
const FactId = z.string().regex(/^f\d+$/);

export const PesquisadorModelOutputSchema = z
  .object({
    identity: z
      .object({
        is_same_company: z.boolean(),
        official_website_result_id: ResultId.nullable(),
        rationale: z.string().min(1),
      })
      .strict(),
    facts: z
      .array(
        z
          .object({
            id: FactId,
            statement: z.string().min(1),
            category: z.enum(FACT_CATEGORIES),
            result_ids: z.array(ResultId).min(1),
          })
          .strict(),
      )
      .max(20),
    hypotheses: z
      .array(
        z
          .object({
            problem: z.enum(PROBLEM_KEYS),
            statement: z.string().min(1),
            based_on_fact_ids: z.array(FactId),
          })
          .strict(),
      )
      .max(5),
    contacts: z
      .array(
        z
          .object({
            channel: z.enum(RESEARCH_CONTACT_CHANNELS),
            value: z.string().min(1),
            person_name: z.string().min(1).nullable(),
            role_title: z.string().min(1).nullable(),
            persona: PersonaSchema.nullable(),
            result_id: ResultId,
          })
          .strict(),
      )
      .max(15),
    criteria: z.array(
      z
        .object({
          key: z.enum(MODEL_SCORED_CRITERIA),
          points: z.number(),
          basis: ScoreBasisSchema,
          rationale: z.string().min(1),
          fact_ids: z.array(FactId),
        })
        .strict(),
    ),
    language: LanguageSchema,
    recommended_next_action: z.string().min(1),
    notes: z.string().nullable(),
  })
  .strict();
export type PesquisadorModelOutput = z.infer<typeof PesquisadorModelOutputSchema>;

export const PESQUISADOR_SCHEMA_NAME = 'research_dossier';

const stringArray = { type: 'array', items: { type: 'string' } };

/** JSON Schema sent to the model. Enumerations come from the Zod schema above. */
export const PESQUISADOR_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'identity',
    'facts',
    'hypotheses',
    'contacts',
    'criteria',
    'language',
    'recommended_next_action',
    'notes',
  ],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['is_same_company', 'official_website_result_id', 'rationale'],
      properties: {
        is_same_company: { type: 'boolean' },
        official_website_result_id: { type: ['string', 'null'], description: 'A result id such as r3, or null.' },
        rationale: { type: 'string' },
      },
    },
    facts: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'statement', 'category', 'result_ids'],
        properties: {
          id: { type: 'string', description: 'f1, f2, ...' },
          statement: { type: 'string' },
          category: { type: 'string', enum: [...FACT_CATEGORIES] },
          result_ids: { ...stringArray, minItems: 1 },
        },
      },
    },
    hypotheses: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['problem', 'statement', 'based_on_fact_ids'],
        properties: {
          problem: { type: 'string', enum: [...PROBLEM_KEYS] },
          statement: { type: 'string' },
          based_on_fact_ids: stringArray,
        },
      },
    },
    contacts: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['channel', 'value', 'person_name', 'role_title', 'persona', 'result_id'],
        properties: {
          channel: { type: 'string', enum: [...RESEARCH_CONTACT_CHANNELS] },
          value: { type: 'string' },
          person_name: { type: ['string', 'null'] },
          role_title: { type: ['string', 'null'] },
          persona: { type: ['string', 'null'], enum: [...PersonaSchema.options, null] },
          result_id: { type: 'string' },
        },
      },
    },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'points', 'basis', 'rationale', 'fact_ids'],
        properties: {
          key: { type: 'string', enum: [...MODEL_SCORED_CRITERIA] },
          points: { type: 'number' },
          basis: { type: 'string', enum: [...ScoreBasisSchema.options] },
          rationale: { type: 'string' },
          fact_ids: stringArray,
        },
      },
    },
    language: { type: 'string', enum: [...LanguageSchema.options] },
    recommended_next_action: { type: 'string' },
    notes: { type: ['string', 'null'] },
  },
};
