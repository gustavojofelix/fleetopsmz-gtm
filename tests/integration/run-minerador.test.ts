import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PipelineError, isPipelineError } from '../../src/infra/errors.js';
import { MINERADOR_PATHS, runMinerador } from '../../src/orchestration/run-minerador.js';
import type { RunMineradorDeps, RunMineradorInput } from '../../src/orchestration/run-minerador.js';
import type { LlmRequest } from '../../src/ports/llm.js';
import {
  LeadRegistrySchema,
  QualifiedLeadSchema,
  RunManifestSchema,
} from '../../src/schemas/index.js';
import { parseCsv } from '../../src/tools/csv.js';
import {
  TEST_MODEL,
  TEST_PROMPT,
  TEST_RUN_ID,
  assessment,
  createMemoryStore,
  createScriptedLlm,
  fixedClock,
  loadTestConfig,
  noSleepRetry,
  rawCsv,
  silentLogger,
} from '../helpers.js';
import type { MemoryStore, ScriptedReply } from '../helpers.js';

const SECOND_RUN_ID = '2026-11-13T0900Z_abc123';
const RAW_PATH = 'data/raw/beira.csv';

const RAW_CONTENT = rawCsv([
  {
    company_name: 'Transportes Exemplo, Lda',
    city: 'Beira',
    phone: '84 123 4567',
    website: 'www.example.com',
    business_description: 'Transporte de carga com camiões próprios.',
    source_url: 'https://directory.example.org/transportes-exemplo',
    source_name: 'Example directory',
  },
  { company_name: 'TRANSPORTES EXEMPLO LIMITADA', city: 'Beira', email: 'geral@example.com' },
  { company_name: 'Logística Modelo SA', city: 'Maputo', business_category: 'Logística' },
  { company_name: 'Padaria Exemplo', city: 'Chimoio' },
  { city: 'Tete' },
]);

async function run(
  store: MemoryStore,
  replies: ScriptedReply[],
  overrides: Partial<RunMineradorInput> = {},
  runId = TEST_RUN_ID,
) {
  const config = await loadTestConfig();
  const llm = createScriptedLlm(replies);
  const deps: RunMineradorDeps = {
    store,
    config,
    llm,
    prompt: TEST_PROMPT,
    model: TEST_MODEL,
    runId,
    logger: silentLogger,
    clock: fixedClock,
    concurrency: 2,
    retry: noSleepRetry,
  };
  const result = await runMinerador(
    { files: [{ path: RAW_PATH, content: RAW_CONTENT }], limit: 5, dryRun: false, force: false, ...overrides },
    deps,
  );
  return { result, llm };
}

const RUN_DIR = `${MINERADOR_PATHS.runs}/${TEST_RUN_ID}`;

describe('runMinerador', () => {
  it('imports, deduplicates, assesses and writes a complete run folder', async () => {
    const store = createMemoryStore();
    const { result, llm } = await run(store, [assessment()]);

    assert.equal(result.input_rows, 5);
    assert.equal(result.valid_rows, 4);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.merged_rows, 1);
    assert.equal(result.candidates, 3);
    assert.equal(result.leads.length, 3);
    assert.equal(result.failures.length, 0);
    assert.equal(llm.requests.length, 3);
    assert.deepEqual(result.usage, { input_tokens: 300, output_tokens: 150 });

    for (const file of [
      'manifest.json',
      'qualified_companies.json',
      'qualified_companies.csv',
      'qualification_summary.md',
      'rejected_rows.csv',
    ]) {
      assert.equal(store.files.has(`${RUN_DIR}/${file}`), true, file);
    }
    assert.equal(store.files.has(`${RUN_DIR}/failures.jsonl`), false);
    assert.equal(store.files.get(MINERADOR_PATHS.latest), `${TEST_RUN_ID}\n`);

    const leads = JSON.parse(store.files.get(`${RUN_DIR}/qualified_companies.json`) ?? '') as unknown[];
    assert.equal(leads.length, 3);
    for (const lead of leads) {
      const parsed = QualifiedLeadSchema.safeParse(lead);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    }

    const csv = parseCsv(store.files.get(`${RUN_DIR}/qualified_companies.csv`) ?? '');
    assert.equal(csv.length, 4);
    assert.equal(csv[0]?.[0], 'lead_id');
    assert.equal(csv[1]?.[1], 'Transportes Exemplo, Lda');

    const manifest = RunManifestSchema.parse(JSON.parse(store.files.get(`${RUN_DIR}/manifest.json`) ?? ''));
    assert.equal(manifest.status, 'completed');
    assert.equal(Object.keys(manifest.records).length, 3);
    assert.equal(manifest.input_files[0]?.path, RAW_PATH);
    assert.equal(manifest.input_files[0]?.rows, 5);

    const registry = LeadRegistrySchema.parse(JSON.parse(store.files.get(MINERADOR_PATHS.registry) ?? ''));
    assert.equal(registry.entries.length, 3);
    assert.equal(store.files.has(`${MINERADOR_PATHS.registrySnapshots}/${TEST_RUN_ID}.json`), true);

    const summary = store.files.get(`${RUN_DIR}/qualification_summary.md`) ?? '';
    assert.match(summary, /Rows merged as duplicates \| 1/);
    assert.match(summary, /Rows rejected at import \| 1/);
    assert.match(summary, /Transportes Exemplo, Lda/);
  });

  it('never stores secrets or writes outside data/', async () => {
    const store = createMemoryStore();
    await run(store, [assessment()]);
    for (const [path, content] of store.files) {
      assert.equal(path.startsWith('data/'), true, path);
      assert.equal(/api[_-]?key/i.test(content), false, path);
    }
    assert.equal(store.files.has(RAW_PATH), false);
  });

  it('keeps going when one company fails and reports the failure', async () => {
    const store = createMemoryStore();
    const reply = (request: LlmRequest): unknown =>
      request.user.includes('Logística Modelo')
        ? new PipelineError({ code: 'provider_permanent', message: 'rejected' })
        : assessment();
    const { result } = await run(store, [reply]);

    assert.equal(result.leads.length, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.company_name, 'Logística Modelo SA');
    assert.equal(result.failures[0]?.code, 'provider_permanent');
    const failures = store.files.get(`${RUN_DIR}/failures.jsonl`) ?? '';
    assert.equal(failures.trim().split('\n').length, 1);
    const manifest = RunManifestSchema.parse(JSON.parse(store.files.get(`${RUN_DIR}/manifest.json`) ?? ''));
    assert.equal(manifest.status, 'completed');
    const states = Object.values(manifest.records).map((r) => r.minerador?.status);
    assert.deepEqual(states.sort(), ['failed', 'ok', 'ok']);
    assert.match(store.files.get(`${RUN_DIR}/qualification_summary.md`) ?? '', /## Failures/);
  });

  it('marks the run failed when no company could be assessed', async () => {
    const store = createMemoryStore();
    const { result } = await run(store, [new PipelineError({ code: 'provider_permanent', message: 'bad key' })]);
    assert.equal(result.leads.length, 0);
    assert.equal(result.failures.length, 3);
    const manifest = RunManifestSchema.parse(JSON.parse(store.files.get(`${RUN_DIR}/manifest.json`) ?? ''));
    assert.equal(manifest.status, 'failed');
  });

  it('reuses cached assessments on a second run and keeps the same lead_ids', async () => {
    const store = createMemoryStore();
    const first = await run(store, [assessment()]);
    const firstFiles = new Map(store.files);

    const second = await run(store, [assessment()], {}, SECOND_RUN_ID);
    assert.equal(second.llm.requests.length, 0);
    assert.equal(second.result.cache_hits, 3);
    assert.deepEqual(second.result.usage, { input_tokens: 0, output_tokens: 0 });
    assert.equal(second.result.new_leads, 0);
    assert.deepEqual(
      second.result.leads.map((lead) => lead.lead_id),
      first.result.leads.map((lead) => lead.lead_id),
    );
    assert.equal(second.result.leads[0]?.provenance.run_id, SECOND_RUN_ID);

    // The first run's folder and registry snapshot are untouched.
    for (const [path, content] of firstFiles) {
      if (path.startsWith(RUN_DIR) || path.startsWith(MINERADOR_PATHS.registrySnapshots)) {
        assert.equal(store.files.get(path), content, path);
      }
    }
    assert.equal(store.files.get(MINERADOR_PATHS.latest), `${SECOND_RUN_ID}\n`);
    const registry = LeadRegistrySchema.parse(JSON.parse(store.files.get(MINERADOR_PATHS.registry) ?? ''));
    assert.equal(registry.entries.length, 3);
  });

  it('recovers an interrupted run: finished companies are not assessed again', async () => {
    const store = createMemoryStore();
    let calls = 0;
    const crashOnThird = (): unknown => {
      calls += 1;
      if (calls === 3) throw new Error('process interrupted');
      return assessment();
    };
    // A non-PipelineError thrown by the model client is contained as a record failure.
    const first = await run(store, [crashOnThird], {}, TEST_RUN_ID);
    assert.equal(first.result.leads.length, 2);
    assert.equal(first.result.failures.length, 1);

    const second = await run(store, [assessment()], {}, SECOND_RUN_ID);
    assert.equal(second.llm.requests.length, 1);
    assert.equal(second.result.cache_hits, 2);
    assert.equal(second.result.leads.length, 3);
  });

  it('calls the model again for every company when forced', async () => {
    const store = createMemoryStore();
    await run(store, [assessment()]);
    const forced = await run(store, [assessment()], { force: true }, SECOND_RUN_ID);
    assert.equal(forced.llm.requests.length, 3);
    assert.equal(forced.result.cache_hits, 0);
  });

  it('refuses to reuse a run ID, so earlier results cannot be overwritten', async () => {
    const store = createMemoryStore();
    await run(store, [assessment()]);
    await assert.rejects(run(store, [assessment()]), (error: unknown) =>
      isPipelineError(error) && error.code === 'io',
    );
  });

  it('respects the batch limit and reports what was left out', async () => {
    const store = createMemoryStore();
    const { result, llm } = await run(store, [assessment()], { limit: 2 });
    assert.equal(llm.requests.length, 2);
    assert.equal(result.leads.length, 2);
    assert.equal(result.not_processed, 1);
    assert.match(
      store.files.get(`${RUN_DIR}/qualification_summary.md`) ?? '',
      /Not processed \(batch limit\) \| 1/,
    );
  });

  it('does a dry run without model calls and without writing anything', async () => {
    const store = createMemoryStore();
    const config = await loadTestConfig();
    const result = await runMinerador(
      { files: [{ path: RAW_PATH, content: RAW_CONTENT }], limit: 5, dryRun: true, force: false },
      {
        store,
        config,
        llm: null,
        prompt: '',
        model: '',
        runId: TEST_RUN_ID,
        logger: silentLogger,
        clock: fixedClock,
        concurrency: 2,
      },
    );
    assert.equal(result.dry_run, true);
    assert.equal(result.run_dir, null);
    assert.equal(result.candidates, 3);
    assert.equal(result.valid_rows, 4);
    assert.equal(result.rejected.length, 1);
    assert.equal(store.files.size, 0);
  });

  it('fails fast on a corrupt registry instead of minting new IDs', async () => {
    const store = createMemoryStore({ [MINERADOR_PATHS.registry]: '{"entries": "broken"}' });
    await assert.rejects(run(store, [assessment()]), (error: unknown) =>
      isPipelineError(error) && error.code === 'config',
    );
  });
});
