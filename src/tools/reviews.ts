import { parseCollectedAt } from '../domain/normalize.js';
import { ApprovalRecordSchema, PromotionRecordSchema } from '../schemas/index.js';
import type { ApprovalRecord, PromotionRecord } from '../schemas/index.js';
import { parseCsv } from './csv.js';

export interface ReviewFile<T> {
  records: T[];
  /** Rows that could not be read, with the reason. They are ignored, not guessed. */
  problems: string[];
}

function readRows(text: string, required: readonly string[], label: string) {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((name) => name.trim().toLowerCase());
  const problems: string[] = [];
  const missing = required.filter((column) => !header.includes(column));
  if (table.length > 0 && missing.length > 0) {
    problems.push(`${label}: missing column(s) ${missing.join(', ')}`);
    return { rows: [], problems };
  }
  const rows = table.slice(1).map((cells, index) => {
    const row: Record<string, string | null> = {};
    header.forEach((column, position) => {
      const value = (cells[position] ?? '').trim();
      row[column] = value === '' ? null : value;
    });
    return { row, line: index + 2 };
  });
  return { rows, problems };
}

function describe(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/** Reads data/reviews/promotions.csv. `decided_at` may be a date or a timestamp. */
export function parsePromotionsCsv(text: string): ReviewFile<PromotionRecord> {
  const { rows, problems } = readRows(
    text,
    ['lead_id', 'decision', 'reviewer', 'decided_at'],
    'promotions.csv',
  );
  const records: PromotionRecord[] = [];
  for (const { row, line } of rows) {
    const parsed = PromotionRecordSchema.safeParse({
      lead_id: row['lead_id'],
      decision: row['decision']?.toLowerCase(),
      reviewer: row['reviewer'],
      decided_at: parseCollectedAt(row['decided_at'] ?? null),
      note: row['note'] ?? null,
    });
    if (parsed.success) records.push(parsed.data);
    else problems.push(`promotions.csv row ${line}: ${describe(parsed.error)}`);
  }
  return { records, problems };
}

/** Reads data/reviews/approvals.csv. */
export function parseApprovalsCsv(text: string): ReviewFile<ApprovalRecord> {
  const { rows, problems } = readRows(
    text,
    ['draft_id', 'lead_id', 'decision', 'reviewer', 'decided_at'],
    'approvals.csv',
  );
  const records: ApprovalRecord[] = [];
  for (const { row, line } of rows) {
    const parsed = ApprovalRecordSchema.safeParse({
      draft_id: row['draft_id'],
      lead_id: row['lead_id'],
      decision: row['decision']?.toLowerCase(),
      reviewer: row['reviewer'],
      decided_at: parseCollectedAt(row['decided_at'] ?? null),
      note: row['note'] ?? null,
    });
    if (parsed.success) records.push(parsed.data);
    else problems.push(`approvals.csv row ${line}: ${describe(parsed.error)}`);
  }
  return { records, problems };
}

/** The most recent decision per key; later rows win when timestamps are equal. */
export function latestDecisions<T extends { decided_at: string }>(
  records: readonly T[],
  keyOf: (record: T) => string,
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const record of records) {
    const current = latest.get(keyOf(record));
    if (current === undefined || record.decided_at >= current.decided_at) {
      latest.set(keyOf(record), record);
    }
  }
  return latest;
}
