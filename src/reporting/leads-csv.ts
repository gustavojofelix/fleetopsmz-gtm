import { IcpCriterionKeySchema } from '../schemas/lead.js';
import type { QualifiedLead } from '../schemas/lead.js';
import type { RejectedRawRow } from '../schemas/raw.js';
import { stringifyCsv } from '../tools/csv.js';
import type { CsvValue } from '../tools/csv.js';

const CRITERIA = IcpCriterionKeySchema.options;

export const LEAD_CSV_COLUMNS: readonly string[] = [
  'lead_id',
  'company_name',
  'city',
  'province',
  'country',
  'business_segment',
  'sub_segment',
  'icp_score',
  'icp_coverage',
  'priority',
  'qualification_status',
  'review_reason',
  'confidence',
  'website',
  'phones',
  'emails',
  'source_urls',
  'merged_rows',
  ...CRITERIA.map((key) => `points_${key}`),
  'run_id',
  'processed_at',
];

function contactValues(lead: QualifiedLead, channel: 'phone' | 'email'): string {
  return lead.public_contacts
    .filter((contact) => contact.channel === channel)
    .map((contact) => contact.value)
    .join('; ');
}

/** One flat row per lead, for spreadsheets and CRM import. */
export function leadsToCsv(leads: readonly QualifiedLead[]): string {
  const rows: CsvValue[][] = leads.map((lead) => [
    lead.lead_id,
    lead.company_name,
    lead.city,
    lead.province,
    lead.country,
    lead.business_segment,
    lead.sub_segment,
    lead.icp.score,
    lead.icp.coverage,
    lead.icp.priority,
    lead.qualification_status,
    lead.review_reason,
    lead.confidence,
    lead.website,
    contactValues(lead, 'phone'),
    contactValues(lead, 'email'),
    lead.source_urls.map((source) => source.url).join('; '),
    lead.merged_raw_ids.length,
    ...CRITERIA.map((key) => lead.icp.criteria.find((c) => c.key === key)?.points ?? 0),
    lead.provenance.run_id,
    lead.provenance.processed_at,
  ]);
  return stringifyCsv([LEAD_CSV_COLUMNS, ...rows]);
}

/** Rows that failed validation at import, with the reason and the original values. */
export function rejectedRowsToCsv(rejected: readonly RejectedRawRow[]): string {
  return stringifyCsv([
    ['source_file', 'row_number', 'reason', 'original'],
    ...rejected.map((row) => [
      row.source_file,
      row.row_number,
      row.reason,
      JSON.stringify(row.original),
    ]),
  ]);
}
