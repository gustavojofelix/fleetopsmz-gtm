import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

export const CapabilityStatusSchema = z.enum([
  'implemented',
  'partially_implemented',
  'planned',
  'unverified',
  'not_available',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

/**
 * One FleetOps MZ product capability. Status is set by a person who has checked
 * the product; it is never inferred from documentation.
 */
export const CapabilityEntrySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'invalid capability key'),
    name_en: z.string().min(1),
    name_pt: z.string().min(1),
    status: CapabilityStatusSchema,
    /** Required for partially_implemented: what the capability cannot do yet. */
    limitations: z.string().min(1).nullable(),
    verified_by: z.string().min(1).nullable(),
    verified_at: IsoDateTimeSchema.nullable(),
    /** Terms that identify this capability in message text. */
    keywords: z.array(z.string().min(1)),
    notes: z.string().nullable(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const presentable =
      entry.status === 'implemented' || entry.status === 'partially_implemented';
    if (presentable && (entry.verified_by === null || entry.verified_at === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verified_by'],
        message: `status "${entry.status}" needs verified_by and verified_at`,
      });
    }
    if (entry.status === 'partially_implemented' && entry.limitations === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limitations'],
        message: 'partially_implemented needs explicit limitations',
      });
    }
  });
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const CapabilityRegistrySchema = z
  .object({
    schema_version: z.literal(1),
    updated_at: IsoDateTimeSchema.nullable(),
    capabilities: z.array(CapabilityEntrySchema).min(1),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const keys = registry.capabilities.map((c) => c.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'capability keys must be unique',
      });
    }
  });
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;
