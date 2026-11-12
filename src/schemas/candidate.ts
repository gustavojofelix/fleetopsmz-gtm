import { z } from 'zod';
import { IdentityKeySchema } from './lead.js';
import { IsoDateTimeSchema, LeadIdSchema } from './primitives.js';
import { RawCompanyRecordSchema } from './raw.js';

/** A contact value taken from a raw row, with the row it came from. */
export const CandidateContactSchema = z
  .object({
    channel: z.enum(['phone', 'email']),
    value: z.string().min(1),
    raw_id: z.string().min(1),
  })
  .strict();
export type CandidateContact = z.infer<typeof CandidateContactSchema>;

/**
 * One company after import, normalization and identity resolution: the input
 * of Agent 1. All raw rows that resolved to the same lead are merged here.
 */
export const LeadCandidateSchema = z
  .object({
    lead_id: LeadIdSchema,
    /** False when the lead already existed in the registry before this run. */
    is_new: z.boolean(),
    company_name: z.string().min(1),
    normalized_name: z.string().min(1),
    city: z.string().min(1).nullable(),
    province: z.string().min(1).nullable(),
    country: z.string().min(1),
    /** True when the city is listed in config/geography.json. */
    location_listed: z.boolean(),
    priority_rank: z.number().int().positive().nullable(),
    website: z.string().url().nullable(),
    contacts: z.array(CandidateContactSchema),
    business_categories: z.array(z.string().min(1)),
    business_descriptions: z.array(z.string().min(1)),
    keys: z.array(IdentityKeySchema),
    records: z.array(RawCompanyRecordSchema).min(1),
    /** Other leads with the same normalized name or a conflicting key match. */
    possible_duplicate_of: z.array(LeadIdSchema),
    /** When the lead was first registered. */
    created_at: IsoDateTimeSchema,
  })
  .strict();
export type LeadCandidate = z.infer<typeof LeadCandidateSchema>;
