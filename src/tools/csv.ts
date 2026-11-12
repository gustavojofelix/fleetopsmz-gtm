/**
 * Minimal CSV reader and writer (RFC 4180): quoted fields, escaped quotes,
 * line breaks inside quotes, CRLF or LF, optional UTF-8 BOM. The reader also
 * accepts semicolon-separated files, which Excel produces in Portuguese locales.
 */

const BOM = '﻿';

function detectDelimiter(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') commas += 1;
    else if (!quoted && char === ';') semicolons += 1;
    else if (!quoted && (char === '\n' || char === '\r')) break;
  }
  return semicolons > commas ? ';' : ',';
}

/** Parses CSV text into rows of cells. Rows that are completely empty are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      endCell();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Guards against spreadsheet formula injection: text starting with "=" or "@"
 * is prefixed with an apostrophe so it is shown, not executed. Phone numbers
 * starting with "+" are left as they are.
 */
function neutralize(text: string): string {
  return /^[=@]/.test(text) ? `'${text}` : text;
}

function formatCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? neutralize(value) : String(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serializes rows to CSV with CRLF line endings and a BOM so Excel reads UTF-8. */
export function stringifyCsv(rows: readonly (readonly CsvValue[])[]): string {
  return BOM + rows.map((row) => row.map(formatCell).join(',')).join('\r\n') + '\r\n';
}
