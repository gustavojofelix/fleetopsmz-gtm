import { z } from 'zod';

export const CopywriterModelOutputSchema = z
  .object({
    drafts: z
      .array(
        z
          .object({
            target_id: z.string().regex(/^t\d+$/),
            subject: z.string().min(1).nullable(),
            body: z.string().min(1),
            call_to_action: z.string().min(1),
            opt_out_line: z.string().min(1),
            /** Ids of the verified facts used, as given in the input (v1, v2, ...). */
            fact_ids: z.array(z.string().regex(/^v\d+$/)),
            /** Keys of the product capabilities mentioned. */
            capability_keys: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type CopywriterModelOutput = z.infer<typeof CopywriterModelOutputSchema>;
export type ModelDraft = CopywriterModelOutput['drafts'][number];

export const COPYWRITER_SCHEMA_NAME = 'outreach_drafts';

export const COPYWRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['drafts'],
  properties: {
    drafts: {
      type: 'array',
      minItems: 1,
      description: 'Exactly one draft for each target in <targets>.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'target_id',
          'subject',
          'body',
          'call_to_action',
          'opt_out_line',
          'fact_ids',
          'capability_keys',
        ],
        properties: {
          target_id: { type: 'string', description: 't1, t2, ...' },
          subject: { type: ['string', 'null'], description: 'Required for email, null otherwise.' },
          body: { type: 'string', description: 'The message, without signature or opt-out line.' },
          call_to_action: { type: 'string', description: 'The single request made, as one sentence.' },
          opt_out_line: { type: 'string' },
          fact_ids: { type: 'array', items: { type: 'string' } },
          capability_keys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};
