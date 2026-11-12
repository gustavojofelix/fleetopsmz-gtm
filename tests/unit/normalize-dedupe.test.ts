import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyRegistry, resolveLeads } from '../../src/domain/dedupe.js';
import { identityKeysFor, mintLeadId } from '../../src/domain/identity.js';
import {
  normalizeCompanyName,
  normalizeEmail,
  normalizePhone,
  normalizePhones,
  normalizeWebsite,
  parseCollectedAt,
  resolveLocation,
} from '../../src/domain/normalize.js';
import { LeadCandidateSchema, LeadRegistrySchema } from '../../src/schemas/index.js';
import { importRawContent } from '../../src/tools/import.js';
import { TEST_RUN_ID, loadTestConfig, rawCsv } from '../helpers.js';

const NOW = '2026-11-12T16:40:00Z';
const CONTEXT = { run_id: TEST_RUN_ID, now: NOW };

function records(rows: Record<string, string>[], fileName = 'a.csv') {
  return importRawContent({ fileName, content: rawCsv(rows), importedAt: NOW }).records;
}

describe('normalizeCompanyName', () => {
  const cases: [string, string][] = [
    ['Transportes Exemplo, Lda.', 'transportes exemplo'],
    ['TRANSPORTES EXEMPLO LIMITADA', 'transportes exemplo'],
    ['Logística Modelo, S.A.', 'logistica modelo'],
    ['Logistica Modelo SA', 'logistica modelo'],
    ['Silva & Filhos, L.D.A', 'silva e filhos'],
    ['Carga Rápida (Pty) Ltd', 'carga rapida'],
    ['Exemplo Sociedade Unipessoal Lda', 'exemplo'],
    ['Açúcar e Transporte S.A.R.L.', 'acucar e transporte'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" becomes "${expected}"`, () => {
      assert.equal(normalizeCompanyName(input), expected);
    });
  }

  it('keeps a name made only of legal-form words instead of emptying it', () => {
    assert.equal(normalizeCompanyName('SA Lda'), 'sa');
  });

  it('does not strip legal-form letters from the middle of a name', () => {
    assert.equal(normalizeCompanyName('SA Transportes'), 'sa transportes');
  });
});

describe('normalizePhone', () => {
  const cases: [string, string | null][] = [
    ['84 123 4567', '+258841234567'],
    ['+258 84 123 4567', '+258841234567'],
    ['00258841234567', '+258841234567'],
    ['258-84-1234567', '+258841234567'],
    ['23 320 123', '+25823320123'],
    ['+27 11 555 0100', '+27115550100'],
    ['12345', null],
    ['n/a', null],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" becomes ${String(expected)}`, () => {
      assert.equal(normalizePhone(input), expected);
    });
  }

  it('splits a cell with several numbers and removes repeats', () => {
    assert.deepEqual(normalizePhones('84 123 4567 / +258841234567; 82 765 4321'), [
      '+258841234567',
      '+258827654321',
    ]);
  });
});

describe('normalizeWebsite and normalizeEmail', () => {
  it('adds a scheme, lowercases the host and drops www for the domain', () => {
    assert.deepEqual(normalizeWebsite('WWW.Example.com/'), {
      url: 'https://www.example.com',
      domain: 'example.com',
      identifying: true,
    });
  });

  it('keeps a social page as a website but not as an identity key', () => {
    const page = normalizeWebsite('https://www.facebook.com/exemplo');
    assert.equal(page?.url, 'https://www.facebook.com/exemplo');
    assert.equal(page?.identifying, false);
  });

  it('returns null for values that are not URLs', () => {
    assert.equal(normalizeWebsite('não tem'), null);
    assert.equal(normalizeWebsite('localhost'), null);
    assert.equal(normalizeWebsite('ftp://example.com'), null);
    assert.equal(normalizeWebsite(null), null);
  });

  it('treats webmail domains as non-identifying', () => {
    assert.equal(normalizeEmail('Geral@Example.com')?.identifying, true);
    assert.equal(normalizeEmail('exemplo@gmail.com')?.identifying, false);
    assert.equal(normalizeEmail('not-an-email'), null);
  });
});

describe('resolveLocation and parseCollectedAt', () => {
  it('maps cities and aliases to canonical names and provinces', async () => {
    const { geography } = await loadTestConfig();
    assert.deepEqual(resolveLocation('cidade da beira', null, geography), {
      city: 'Beira',
      province: 'Sofala',
      listed: true,
      priority_rank: 1,
    });
    assert.equal(resolveLocation('NACALA-PORTO', 'x', geography).province, 'Nampula');
    assert.equal(resolveLocation('Zambezia', null, geography).listed, false);
  });

  it('keeps an unlisted city as collected and never guesses a province', async () => {
    const { geography } = await loadTestConfig();
    assert.deepEqual(resolveLocation(' Vilankulo ', null, geography), {
      city: 'Vilankulo',
      province: null,
      listed: false,
      priority_rank: null,
    });
    assert.equal(resolveLocation(null, null, geography).city, null);
  });

  it('accepts ISO dates only', () => {
    assert.equal(parseCollectedAt('2026-11-10'), '2026-11-10T00:00:00Z');
    assert.equal(parseCollectedAt('2026-11-10T08:30:00+02:00'), '2026-11-10T06:30:00.000Z');
    assert.equal(parseCollectedAt('10/11/2026'), null);
    assert.equal(parseCollectedAt('2026-13-45'), null);
    assert.equal(parseCollectedAt(null), null);
  });
});

describe('identity', () => {
  it('mints well-formed, deterministic IDs that differ by salt', () => {
    const id = mintLeadId('transportes exemplo', 'Mozambique');
    assert.match(id, /^lead_[a-f0-9]{16}$/);
    assert.equal(mintLeadId('transportes exemplo', 'Mozambique'), id);
    assert.notEqual(mintLeadId('transportes exemplo', 'Mozambique', 1), id);
    assert.notEqual(mintLeadId('outra empresa', 'Mozambique'), id);
  });

  it('uses name_city when a city is known and name_only otherwise', () => {
    const base = { normalized_name: 'exemplo', domains: [], phones: [] };
    assert.deepEqual(identityKeysFor({ ...base, city: 'Beira' }), [
      { type: 'name_city', value: 'exemplo|beira' },
    ]);
    assert.deepEqual(identityKeysFor({ ...base, city: null }), [
      { type: 'name_only', value: 'exemplo' },
    ]);
  });

  it('puts website and email domains in one namespace, without repeats', () => {
    const keys = identityKeysFor({
      normalized_name: 'exemplo',
      city: 'Beira',
      domains: ['example.com', 'example.com'],
      phones: ['+258841234567'],
    });
    assert.deepEqual(keys, [
      { type: 'domain', value: 'example.com' },
      { type: 'phone', value: '+258841234567' },
      { type: 'name_city', value: 'exemplo|beira' },
    ]);
  });
});

describe('resolveLeads', () => {
  it('merges rows that share a name and city, a phone or a website', async () => {
    const { geography } = await loadTestConfig();
    const rows = records([
      { company_name: 'Transportes Exemplo, Lda', city: 'Beira', phone: '84 123 4567' },
      { company_name: 'TRANSPORTES EXEMPLO LIMITADA', city: 'Cidade da Beira', email: 'geral@example.com' },
      { company_name: 'T. Exemplo', city: 'Dondo', phone: '+258841234567', business_description: 'Transporte de carga' },
      { company_name: 'Exemplo Transportes', website: 'www.example.com' },
      { company_name: 'Logística Modelo SA', city: 'Maputo' },
    ]);
    const result = resolveLeads(rows, emptyRegistry(), geography, CONTEXT);

    assert.equal(result.candidates.length, 2);
    assert.equal(result.merged_rows, 3);
    const merged = result.candidates[0];
    assert.equal(merged?.records.length, 4);
    assert.equal(merged?.company_name, 'Transportes Exemplo, Lda');
    assert.equal(merged?.city, 'Beira');
    assert.equal(merged?.province, 'Sofala');
    assert.equal(merged?.website, 'https://www.example.com');
    assert.deepEqual(merged?.contacts.map((c) => c.value), ['+258841234567', 'geral@example.com']);
    assert.deepEqual(merged?.business_descriptions, ['Transporte de carga']);
    assert.deepEqual(merged?.possible_duplicate_of, []);
    for (const candidate of result.candidates) {
      assert.equal(LeadCandidateSchema.safeParse(candidate).success, true);
    }
    assert.equal(LeadRegistrySchema.safeParse(result.registry).success, true);
  });

  it('does not merge companies that only share a webmail domain', async () => {
    const { geography } = await loadTestConfig();
    const rows = records([
      { company_name: 'Alfa Lda', city: 'Beira', email: 'alfa@gmail.com' },
      { company_name: 'Beta Lda', city: 'Beira', email: 'beta@gmail.com' },
    ]);
    assert.equal(resolveLeads(rows, emptyRegistry(), geography, CONTEXT).candidates.length, 2);
  });

  it('keeps same-name companies in different cities apart and flags both', async () => {
    const { geography } = await loadTestConfig();
    const rows = records([
      { company_name: 'Transportes Exemplo Lda', city: 'Beira' },
      { company_name: 'Transportes Exemplo Lda', city: 'Maputo' },
    ]);
    const { candidates } = resolveLeads(rows, emptyRegistry(), geography, CONTEXT);
    assert.equal(candidates.length, 2);
    const [beira, maputo] = candidates;
    assert.notEqual(beira?.lead_id, maputo?.lead_id);
    assert.deepEqual(beira?.possible_duplicate_of, [maputo?.lead_id]);
    assert.deepEqual(maputo?.possible_duplicate_of, [beira?.lead_id]);
  });

  it('merges rows that have a name and nothing else', async () => {
    const { geography } = await loadTestConfig();
    const rows = records([{ company_name: 'Exemplo Lda' }, { company_name: 'EXEMPLO, LDA.' }]);
    const result = resolveLeads(rows, emptyRegistry(), geography, CONTEXT);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.merged_rows, 1);
  });

  it('resolves to the same lead_id on a later run, even from a different file', async () => {
    const { geography } = await loadTestConfig();
    const first = resolveLeads(
      records([
        { company_name: 'Transportes Exemplo Lda', city: 'Beira', phone: '84 123 4567' },
        { company_name: 'Transportes Exemplo Lda', city: 'Maputo' },
      ]),
      emptyRegistry(),
      geography,
      CONTEXT,
    );
    const later = { run_id: '2026-11-13T0900Z_abc123', now: '2026-11-13T09:00:00Z' };
    const second = resolveLeads(
      records(
        [
          { company_name: 'Transportes Exemplo Lda', city: 'Maputo' },
          { company_name: 'Exemplo Transp.', phone: '+258 84 123 4567' },
          { company_name: 'Nova Empresa Lda', city: 'Tete' },
        ],
        'b.csv',
      ),
      first.registry,
      geography,
      later,
    );

    assert.equal(second.candidates[0]?.lead_id, first.candidates[1]?.lead_id);
    assert.equal(second.candidates[1]?.lead_id, first.candidates[0]?.lead_id);
    assert.equal(second.candidates[0]?.is_new, false);
    assert.equal(second.candidates[2]?.is_new, true);
    assert.equal(second.candidates[0]?.created_at, NOW);
    assert.equal(second.registry.entries.length, 3);
    const seenAgain = second.registry.entries.find((e) => e.lead_id === first.candidates[0]?.lead_id);
    assert.equal(seenAgain?.first_seen_run, TEST_RUN_ID);
    assert.equal(seenAgain?.last_seen_run, later.run_id);
  });

  it('does not mutate the registry it is given', async () => {
    const { geography } = await loadTestConfig();
    const registry = emptyRegistry();
    resolveLeads(records([{ company_name: 'Exemplo Lda' }]), registry, geography, CONTEXT);
    assert.deepEqual(registry, emptyRegistry());
  });

  it('flags a record whose keys point at two different existing leads', async () => {
    const { geography } = await loadTestConfig();
    const first = resolveLeads(
      records([
        { company_name: 'Alfa Lda', city: 'Beira', website: 'alfa.example.com' },
        { company_name: 'Beta Lda', city: 'Beira', phone: '84 000 0001' },
      ]),
      emptyRegistry(),
      geography,
      CONTEXT,
    );
    const second = resolveLeads(
      records([{ company_name: 'Gama Lda', website: 'alfa.example.com', phone: '84 000 0001' }], 'b.csv'),
      first.registry,
      geography,
      CONTEXT,
    );
    assert.equal(second.candidates.length, 1);
    assert.equal(second.candidates[0]?.lead_id, first.candidates[0]?.lead_id);
    assert.deepEqual(second.candidates[0]?.possible_duplicate_of, [first.candidates[1]?.lead_id]);
  });
});
