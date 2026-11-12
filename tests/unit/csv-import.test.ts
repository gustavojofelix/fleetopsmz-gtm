import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPipelineError } from '../../src/infra/errors.js';
import { parseCsv, stringifyCsv } from '../../src/tools/csv.js';
import { importRawContent } from '../../src/tools/import.js';
import { RAW_CSV_HEADER, rawCsv } from '../helpers.js';

const NOW = '2026-11-12T16:40:00Z';

describe('parseCsv', () => {
  it('parses quoted fields, escaped quotes and line breaks inside quotes', () => {
    const rows = parseCsv('name,note\r\n"Exemplo, Lda","says ""hello""\nsecond line"\r\n');
    assert.deepEqual(rows, [
      ['name', 'note'],
      ['Exemplo, Lda', 'says "hello"\nsecond line'],
    ]);
  });

  it('accepts LF line endings, a BOM and a missing final newline', () => {
    assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects semicolon-separated files', () => {
    assert.deepEqual(parseCsv('company_name;city\nExemplo, Lda;Beira\n'), [
      ['company_name', 'city'],
      ['Exemplo, Lda', 'Beira'],
    ]);
  });

  it('drops completely empty rows but keeps empty cells', () => {
    assert.deepEqual(parseCsv('a,b\n\n,\nx,\n'), [
      ['a', 'b'],
      ['x', ''],
    ]);
  });
});

describe('stringifyCsv', () => {
  it('round-trips values that need quoting', () => {
    const rows = [
      ['name', 'note'],
      ['Exemplo, Lda', 'line one\nline two "quoted"'],
    ];
    assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
  });

  it('writes null as empty and numbers as text', () => {
    assert.equal(stringifyCsv([['a', null, 3]]), '﻿a,,3\r\n');
  });

  it('neutralizes formulas but leaves phone numbers alone', () => {
    const text = stringifyCsv([['=HYPERLINK("x")', '@cmd', '+258841234567']]);
    assert.equal(text, '﻿"\'=HYPERLINK(""x"")",\'@cmd,+258841234567\r\n');
  });
});

describe('importRawContent', () => {
  it('imports CSV rows with stable IDs, provenance and spreadsheet row numbers', () => {
    const content = rawCsv([
      { company_name: 'Transportes Exemplo, Lda', city: 'Beira', phone: '84 123 4567' },
      { company_name: 'Logística Modelo SA' },
    ]);
    const result = importRawContent({ fileName: 'data/raw/a.csv', content, importedAt: NOW });
    assert.equal(result.total_rows, 2);
    assert.equal(result.records.length, 2);
    assert.equal(result.rejected.length, 0);
    const [first, second] = result.records;
    assert.equal(first?.row_number, 2);
    assert.equal(second?.row_number, 3);
    assert.equal(first?.input.company_name, 'Transportes Exemplo, Lda');
    assert.equal(first?.input.website, null);
    assert.equal(first?.source_file, 'data/raw/a.csv');
    assert.match(first?.raw_id ?? '', /^raw_[a-f0-9]{16}$/);
    assert.notEqual(first?.raw_id, second?.raw_id);

    const again = importRawContent({ fileName: 'data/raw/a.csv', content, importedAt: NOW });
    assert.equal(again.records[0]?.raw_id, first?.raw_id);
    assert.equal(again.sha256, result.sha256);
  });

  it('rejects rows without a company name and keeps importing', () => {
    const content = rawCsv([{ company_name: 'Válida Lda' }, { city: 'Beira' }]);
    const result = importRawContent({ fileName: 'a.csv', content, importedAt: NOW });
    assert.equal(result.records.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.row_number, 3);
    assert.match(result.rejected[0]?.reason ?? '', /company_name/);
  });

  it('accepts headers in any case and preserves unknown columns in extra', () => {
    const content = 'Company_Name, City ,NUIT\nExemplo Lda,Beira,400123456\n';
    const result = importRawContent({ fileName: 'a.csv', content, importedAt: NOW });
    assert.equal(result.records[0]?.input.city, 'Beira');
    assert.deepEqual(result.records[0]?.extra, { nuit: '400123456' });
  });

  it('fails clearly when the header has no company_name column', () => {
    assert.throws(
      () => importRawContent({ fileName: 'a.csv', content: 'name,city\nX,Beira\n', importedAt: NOW }),
      (error: unknown) => isPipelineError(error) && error.code === 'input_validation',
    );
  });

  it('imports JSON with the same schema, including numeric phone values', () => {
    const content = JSON.stringify([
      { company_name: 'Exemplo Lda', phone: 841234567, employees: 12 },
      'not an object',
      { city: 'Beira' },
    ]);
    const result = importRawContent({ fileName: 'a.json', content, importedAt: NOW });
    assert.equal(result.total_rows, 3);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.input.phone, '841234567');
    assert.deepEqual(result.records[0]?.extra, { employees: '12' });
    assert.equal(result.rejected.length, 2);
  });

  it('rejects JSON that is not an array and unsupported extensions', () => {
    const inputError = (error: unknown): boolean =>
      isPipelineError(error) && error.code === 'input_validation';
    assert.throws(() => importRawContent({ fileName: 'a.json', content: '{}', importedAt: NOW }), inputError);
    assert.throws(() => importRawContent({ fileName: 'a.json', content: '{bad', importedAt: NOW }), inputError);
    assert.throws(() => importRawContent({ fileName: 'a.xlsx', content: '', importedAt: NOW }), inputError);
  });

  it('returns no rows for a header-only template', () => {
    const result = importRawContent({ fileName: 'a.csv', content: `${RAW_CSV_HEADER}\n`, importedAt: NOW });
    assert.equal(result.total_rows, 0);
  });
});
