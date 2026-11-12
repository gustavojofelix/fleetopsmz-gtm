import { sha256Hex, shortHash } from '../infra/hash.js';
import { PipelineError } from '../infra/errors.js';
import { RAW_INPUT_COLUMNS, RawCompanyInputSchema } from '../schemas/raw.js';
import type { RawCompanyRecord, RejectedRawRow } from '../schemas/raw.js';
import { parseCsv } from './csv.js';

export interface ImportedFile {
  source_file: string;
  sha256: string;
  /** Data rows found in the file, valid or not. */
  total_rows: number;
  records: RawCompanyRecord[];
  rejected: RejectedRawRow[];
}

interface SourceRow {
  row_number: number;
  values: Record<string, unknown>;
}

const KNOWN_COLUMNS: ReadonlySet<string> = new Set(RAW_INPUT_COLUMNS);

function headerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

function rowsFromCsv(content: string, fileName: string): SourceRow[] {
  const table = parseCsv(content);
  const header = table[0];
  if (header === undefined) return [];
  const columns = header.map(headerKey);
  if (!columns.includes('company_name')) {
    throw new PipelineError({
      code: 'input_validation',
      message: `${fileName}: the header row has no "company_name" column`,
      context: { file: fileName, columns },
    });
  }
  return table.slice(1).map((cells, index) => {
    const values: Record<string, unknown> = {};
    columns.forEach((column, position) => {
      if (column !== '') values[column] = cells[position] ?? '';
    });
    // Row 1 is the header, so the first data row is spreadsheet row 2.
    return { row_number: index + 2, values };
  });
}

function rowsFromJson(content: string, fileName: string): SourceRow[] {
  let data: unknown;
  try {
    data = JSON.parse(content.startsWith('﻿') ? content.slice(1) : content);
  } catch (cause) {
    throw new PipelineError({
      code: 'input_validation',
      message: `${fileName}: not valid JSON`,
      context: { file: fileName },
      cause,
    });
  }
  if (!Array.isArray(data)) {
    throw new PipelineError({
      code: 'input_validation',
      message: `${fileName}: expected a JSON array of company objects`,
      context: { file: fileName },
    });
  }
  return data.map((item: unknown, index) => {
    const values: Record<string, unknown> = {};
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      for (const [key, value] of Object.entries(item)) values[headerKey(key)] = value;
    } else {
      values['__invalid'] = item;
    }
    return { row_number: index + 1, values };
  });
}

/** Template columns keep strings; numbers and booleans (a phone typed as a number) are stringified. */
function toText(value: unknown): unknown {
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
}

function toExtraText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value);
  return text === '' ? null : text;
}

/**
 * Validates the content of one raw file (CSV or JSON, chosen by extension).
 * Pure: the caller reads the file, and nothing is ever written back to it.
 * Invalid rows are returned in `rejected` with a reason; they do not stop the import.
 */
export function importRawContent(input: {
  fileName: string;
  content: string;
  importedAt: string;
}): ImportedFile {
  const { fileName, content, importedAt } = input;
  const isJson = fileName.toLowerCase().endsWith('.json');
  const isCsv = fileName.toLowerCase().endsWith('.csv');
  if (!isJson && !isCsv) {
    throw new PipelineError({
      code: 'input_validation',
      message: `${fileName}: unsupported file type (use .csv or .json)`,
      context: { file: fileName },
    });
  }
  const fileHash = sha256Hex(content);
  const sourceRows = isJson ? rowsFromJson(content, fileName) : rowsFromCsv(content, fileName);

  const records: RawCompanyRecord[] = [];
  const rejected: RejectedRawRow[] = [];

  for (const row of sourceRows) {
    if ('__invalid' in row.values) {
      rejected.push({
        source_file: fileName,
        row_number: row.row_number,
        reason: 'row is not an object',
        original: { value: row.values['__invalid'] },
      });
      continue;
    }
    const known: Record<string, unknown> = {};
    const extra: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(row.values)) {
      if (KNOWN_COLUMNS.has(key)) known[key] = toText(value);
      else extra[key] = toExtraText(value);
    }
    const parsed = RawCompanyInputSchema.safeParse(known);
    if (!parsed.success) {
      rejected.push({
        source_file: fileName,
        row_number: row.row_number,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
          .join('; '),
        original: row.values,
      });
      continue;
    }
    records.push({
      raw_id: `raw_${shortHash([fileHash, String(row.row_number)], 16)}`,
      source_file: fileName,
      source_file_sha256: fileHash,
      row_number: row.row_number,
      input: parsed.data,
      extra,
      imported_at: importedAt,
    });
  }

  return { source_file: fileName, sha256: fileHash, total_rows: sourceRows.length, records, rejected };
}
