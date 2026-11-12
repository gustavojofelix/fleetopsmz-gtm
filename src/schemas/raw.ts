import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

/** Column order of the standard raw input template (CSV header and JSON keys). */
export const RAW_INPUT_COLUMNS = [
  'company_name',
  'city',
  'province',
  'phone',
  'email',
  'website',
  'business_category',
  'business_description',
  'source_url',
  'source_name',
  'collected_at',
] as const;
export type RawInputColumn = (typeof RAW_INPUT_COLUMNS)[number];

function trimToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/** Optional free-text column: missing or blank becomes null, never a guess. */
const optionalText = z.preprocess(trimToNull, z.string().nullable());

/**
 * One row of raw input, from CSV or JSON. Only company_name is required.
 * Values are kept as collected: formats (phone, URL, date) are normalized
 * later by the domain layer, so a messy row is not rejected here.
 */
export const RawCompanyInputSchema = z.object({
  company_name: z.preprocess(
    trimToNull,
    z.string({ invalid_type_error: 'company_name is required' }).min(1),
  ),
  city: optionalText,
  province: optionalText,
  phone: optionalText,
  email: optionalText,
  website: optionalText,
  business_category: optionalText,
  business_description: optionalText,
  source_url: optionalText,
  source_name: optionalText,
  collected_at: optionalText,
});
export type RawCompanyInput = z.infer<typeof RawCompanyInputSchema>;

/**
 * A raw row after import: the validated input plus where it came from.
 * Columns outside the template are preserved in `extra`, not dropped.
 */
export const RawCompanyRecordSchema = z
  .object({
    raw_id: z.string().regex(/^raw_[a-f0-9]{16}$/, 'invalid raw_id'),
    source_file: z.string().min(1),
    source_file_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    row_number: z.number().int().positive(),
    input: RawCompanyInputSchema,
    extra: z.record(z.string(), z.string().nullable()),
    imported_at: IsoDateTimeSchema,
  })
  .strict();
export type RawCompanyRecord = z.infer<typeof RawCompanyRecordSchema>;

/** A row that failed validation at import, kept for the rejected-rows report. */
export const RejectedRawRowSchema = z
  .object({
    source_file: z.string().min(1),
    row_number: z.number().int().positive(),
    reason: z.string().min(1),
    original: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RejectedRawRow = z.infer<typeof RejectedRawRowSchema>;
