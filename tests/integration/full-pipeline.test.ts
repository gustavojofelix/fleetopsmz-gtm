import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseAgents } from '../../src/cli/commands.js';
import type { ProjectConfig } from '../../src/config/project-config.js';
import { selectForResearch } from '../../src/domain/gates.js';
import { PipelineError, isPipelineError } from '../../src/infra/errors.js';
import {
  latestPerKey,
  loadApprovals,
  loadDossiers,
  loadPackages,
  loadPromotions,
  loadQualifiedLeads,
} from '../../src/orchestration/load.js';
import { runCopywriter } from '../../src/orchestration/run-copywriter.js';
import { runMinerador } from '../../src/orchestration/run-minerador.js';
import { runPesquisador } from '../../src/orchestration/run-pesquisador.js';
import { STAGE_PATHS, companyFileStem, resolveSourceRun } from '../../src/orchestration/run-store.js';
import type { LlmRequest } from '../../src/ports/llm.js';
import { computeKpis, renderKpiReport } from '../../src/reporting/kpi-report.js';
import { RunManifestSchema } from '../../src/schemas/index.js';
import type { ApprovalRecord } from '../../src/schemas/index.js';
import { parseCsv } from '../../src/tools/csv.js';
import {
  RESEARCH_RESULTS,
  SOURCED_ROW,
  TEST_MODEL,
  TEST_NOW,
  TEST_PROMPT,
  TEST_RUN_ID,
  assessment,
  copyReply,
  createFakeSearchProvider,
  createMemoryStore,
  createScriptedLlm,
  fixedClock,
  loadConfigWithSender,
  loadTestConfig,
  noSleepRetry,
  rawCsv,
  researchReading,
  silentLogger,
} from '../helpers.js';
import type { FakeSearchProvider, MemoryStore, ScriptedLlm } from '../helpers.js';

const SECOND_RUN_ID = '2026-11-13T0900Z_abc123';
const noWait = async (): Promise<void> => {};

const RAW = rawCsv([
  SOURCED_ROW,
  { company_name: 'Padaria Exemplo', city: 'Chimoio' },
  { company_name: 'Construções Modelo, Lda', city: 'Tete', business_description: 'Construção civil.' },
]);

/** Routes each request to the right scripted reply by the schema it asks for. */
function router(request: LlmRequest): unknown {
  if (request.schemaName === 'minerador_assessment') {
    if (request.user.includes('Construções Modelo')) {
      return assessment({
        business_segment: 'fleet_intensive',
        evidence: [],
        criteria: assessment().criteria.map((c) => ({ ...c, points: Math.min(c.points, 6), evidence_ids: [], basis: c.basis === 'unknown' ? 'unknown' : 'inference' })),
      });
    }
    return assessment();
  }
  if (request.schemaName === 'research_dossier') return researchReading();
  if (request.schemaName === 'outreach_drafts') return copyReply(request);
  throw new Error(`unexpected schema ${request.schemaName}`);
}

interface Pipeline {
  store: MemoryStore;
  llm: ScriptedLlm;
  search: FakeSearchProvider;
  config: ProjectConfig;
}

async function setup(store = createMemoryStore()): Promise<Pipeline> {
  return {
    store,
    llm: createScriptedLlm([router]),
    search: createFakeSearchProvider(),
    config: await loadConfigWithSender(),
  };
}

async function runAll(p: Pipeline, runId = TEST_RUN_ID) {
  const shared = {
    store: p.store,
    config: p.config,
    llm: p.llm,
    model: TEST_MODEL,
    runId,
    logger: silentLogger,
    clock: fixedClock,
    concurrency: 2,
    retry: noSleepRetry,
  };
  const mined = await runMinerador(
    { files: [{ path: 'data/raw/beira.csv', content: RAW }], limit: 5, dryRun: false, force: false },
    { ...shared, prompt: TEST_PROMPT },
  );
  const promotions = await loadPromotions(p.store);
  const selection = selectForResearch(mined.leads, promotions.latest);
  const researched = await runPesquisador(
    {
      leads: selection.selected,
      held: selection.held.map((h) => ({ lead_id: h.lead.lead_id, company_name: h.lead.company_name, reason: h.reason })),
      sourceRun: null,
      force: false,
    },
    { ...shared, searchProvider: p.search, prompt: TEST_PROMPT, sleep: noWait },
  );
  const written = await runCopywriter(
    { dossiers: researched.dossiers, sourceRun: null, force: false },
    { ...shared, prompt: TEST_PROMPT },
  );
  return { mined, selection, researched, written };
}

describe('full pipeline', () => {
  it('runs the three agents in sequence under one run ID', async () => {
    const p = await setup();
    const { mined, selection, researched, written } = await runAll(p);

    // Agent 1: three companies; the construction company is held for review.
    assert.equal(mined.leads.length, 3);
    assert.deepEqual(selection.selected.map((l) => l.company_name), ['Transportes Exemplo, Lda', 'Padaria Exemplo']);
    assert.equal(selection.held[0]?.lead.company_name, 'Construções Modelo, Lda');

    // Agent 2: one company confirmed, one whose results are about someone else.
    assert.equal(researched.dossiers.length, 2);
    assert.equal(researched.counts.complete, 1);
    assert.equal(researched.counts.insufficient, 1);
    assert.equal(p.search.queries.length, 8);

    // Agent 3: drafts only for the confirmed company.
    assert.equal(written.draft_type, 'institutional_intro');
    assert.equal(written.packages.length, 1);
    assert.equal(written.drafts, 5);
    assert.equal(written.skipped.length, 1);
    assert.equal(written.skipped[0]?.company_name, 'Padaria Exemplo');
    assert.equal(written.failures.length, 0);

    for (const stage of [STAGE_PATHS.qualified, STAGE_PATHS.researched, STAGE_PATHS.outreach]) {
      assert.equal(p.store.files.get(stage.latest), `${TEST_RUN_ID}\n`);
      const manifest = RunManifestSchema.parse(
        JSON.parse(p.store.files.get(`${stage.runs}/${TEST_RUN_ID}/manifest.json`) ?? ''),
      );
      assert.equal(manifest.status, 'completed');
      assert.equal(p.store.files.has(`${stage.runs}/${TEST_RUN_ID}/summary.json`), true);
    }
  });

  it('writes dossiers, message sets, a consolidated CSV and summaries', async () => {
    const p = await setup();
    const { researched, written } = await runAll(p);
    const lead = researched.dossiers[0]?.lead;
    assert.ok(lead);
    const stem = companyFileStem({ city: lead.city, company_name: lead.company_name, lead_id: lead.lead_id, date: TEST_NOW });
    assert.match(stem, /^beira_transportes-exemplo-lda_[a-f0-9]{8}_2026-11-12$/);

    const research = `${STAGE_PATHS.researched.runs}/${TEST_RUN_ID}`;
    for (const file of ['dossiers.json', `dossiers/${stem}.json`, `dossiers/${stem}.md`, 'research_summary.md']) {
      assert.equal(p.store.files.has(`${research}/${file}`), true, file);
    }
    const outreach = `${STAGE_PATHS.outreach.runs}/${TEST_RUN_ID}`;
    for (const file of [
      'outreach_packages.json',
      'outreach_ready.csv',
      'outreach_summary.md',
      `companies/${stem}/dossier.md`,
      `companies/${stem}/dossier.json`,
      `companies/${stem}/outreach.md`,
      `companies/${stem}/outreach.json`,
    ]) {
      assert.equal(p.store.files.has(`${outreach}/${file}`), true, file);
    }

    const csv = parseCsv(p.store.files.get(`${outreach}/outreach_ready.csv`) ?? '');
    assert.equal(csv.length, 1 + written.drafts);
    const researchSummary = p.store.files.get(`${research}/research_summary.md`) ?? '';
    assert.match(researchSummary, /Research completion rate \| 50%/);
    assert.match(researchSummary, /Construções Modelo, Lda \| held for manual review \(priority_c\)/);
    const outreachSummary = p.store.files.get(`${outreach}/outreach_summary.md`) ?? '';
    assert.match(outreachSummary, /\*\*Nothing has been sent\.\*\*/);
    assert.match(outreachSummary, /Padaria Exemplo \| company identity is not verified/);
    assert.match(outreachSummary, /make no product capability claims/);
    for (const path of p.store.files.keys()) assert.equal(path.startsWith('data/'), true, path);
  });

  it('reuses every search and model result on a second run and leaves the first run untouched', async () => {
    const p = await setup();
    await runAll(p);
    const before = new Map(p.store.files);
    const llmCalls = p.llm.requests.length;
    const searchCalls = p.search.queries.length;

    const second = await runAll(p, SECOND_RUN_ID);
    assert.equal(p.llm.requests.length, llmCalls);
    assert.equal(p.search.queries.length, searchCalls);
    assert.equal(second.researched.searches_run, 0);
    assert.equal(second.written.drafts, 5);
    assert.deepEqual(
      second.written.packages[0]?.pkg.drafts.map((d) => d.draft_id),
      (await loadPackages(p.store, TEST_RUN_ID))[0]?.drafts.map((d) => d.draft_id),
    );
    for (const [path, content] of before) {
      if (path.includes(`/runs/${TEST_RUN_ID}/`)) assert.equal(p.store.files.get(path), content, path);
    }
    assert.equal(p.store.files.get(STAGE_PATHS.outreach.latest), `${SECOND_RUN_ID}\n`);
  });

  it('refuses to write into an existing run folder', async () => {
    const p = await setup();
    await runAll(p);
    await assert.rejects(runAll(p), (error: unknown) => isPipelineError(error) && error.code === 'io');
  });

  it('researches a held lead once a reviewer promotes it', async () => {
    const first = await setup();
    const { selection } = await runAll(first);
    const heldId = selection.held[0]?.lead.lead_id ?? '';

    const store = createMemoryStore({
      [STAGE_PATHS.reviews.promotions]: `lead_id,decision,reviewer,decided_at,note\n${heldId},promote,Gustavo,2026-11-13,\n`,
    });
    const p = await setup(store);
    const promoted = await runAll(p);
    assert.equal(promoted.selection.selected.length, 3);
    assert.equal(promoted.selection.held.length, 0);
    assert.equal(promoted.researched.dossiers.length, 3);
  });

  it('isolates a company whose research fails', async () => {
    const p = await setup();
    p.search = createFakeSearchProvider((query) =>
      query.includes('Padaria') ? new PipelineError({ code: 'provider_permanent', message: 'rejected' }) : RESEARCH_RESULTS,
    );
    const { researched, written } = await runAll(p);
    assert.equal(researched.dossiers.length, 1);
    assert.equal(researched.failures.length, 1);
    assert.equal(researched.failures[0]?.company_name, 'Padaria Exemplo');
    assert.equal(p.store.files.has(`${STAGE_PATHS.researched.runs}/${TEST_RUN_ID}/failures.jsonl`), true);
    assert.equal(written.packages.length, 1);
  });

  it('stops before writing anything when the sender is not configured', async () => {
    const p = await setup();
    p.config = await loadTestConfig();
    await assert.rejects(runAll(p), (error: unknown) =>
      isPipelineError(error) && error.code === 'config' && /outreach\.json/.test(error.message),
    );
    assert.equal([...p.store.files.keys()].some((path) => path.startsWith(STAGE_PATHS.outreach.runs)), false);
  });

  it('reloads each stage from disk for a later run', async () => {
    const p = await setup();
    const { mined, researched, written } = await runAll(p);
    const source = await resolveSourceRun(p.store, STAGE_PATHS.qualified, undefined);
    assert.equal(source, TEST_RUN_ID);
    assert.deepEqual(await loadQualifiedLeads(p.store, source), mined.leads);
    assert.deepEqual(await loadDossiers(p.store, TEST_RUN_ID), researched.dossiers);
    assert.deepEqual(await loadPackages(p.store, TEST_RUN_ID), written.packages.map((e) => e.pkg));
    await assert.rejects(resolveSourceRun(p.store, STAGE_PATHS.qualified, '2020-01-01T0000Z_zzzzzz'));
    await assert.rejects(resolveSourceRun(createMemoryStore(), STAGE_PATHS.researched, undefined), (error: unknown) =>
      isPipelineError(error) && /Run the previous agent first/.test(error.message),
    );
  });
});

describe('KPI report', () => {
  it('computes acquisition and quality KPIs, including approvals', async () => {
    const p = await setup();
    const { mined, researched, written } = await runAll(p);
    const drafts = written.packages[0]?.pkg.drafts ?? [];
    const decision = (index: number, value: ApprovalRecord['decision']): [string, ApprovalRecord] => {
      const draft = drafts[index];
      assert.ok(draft);
      return [draft.draft_id, { draft_id: draft.draft_id, lead_id: written.packages[0]!.pkg.lead_id, decision: value, reviewer: 'Gustavo', decided_at: TEST_NOW, note: null }];
    };
    const input = {
      generated_at: TEST_NOW,
      registered_leads: 3,
      leads: mined.leads,
      dossiers: researched.dossiers,
      packages: written.packages.map((e) => e.pkg),
      approvals: new Map([decision(0, 'approved'), decision(1, 'approved'), decision(2, 'rejected'), decision(3, 'changes_requested')]),
      import_totals: { valid_rows: 4, merged_rows: 1 },
    };
    const kpis = computeKpis(input);
    assert.equal(kpis.companies_discovered, 3);
    assert.equal(kpis.companies_qualified, 2);
    assert.equal(kpis.held_for_review, 1);
    assert.equal(kpis.researched, 2);
    assert.equal(kpis.research_completion_rate, 0.5);
    assert.equal(kpis.verified_business_contact_rate, 0.5);
    assert.equal(kpis.drafts_prepared, 5);
    assert.equal(kpis.drafts_approved, 2);
    assert.equal(kpis.drafts_pending, 1);
    assert.equal(kpis.duplicate_rate, 0.25);
    assert.equal(kpis.substantial_correction_rate, 0.5);

    const report = renderKpiReport(input);
    assert.match(report, /Outreach messages approved \| 2/);
    assert.match(report, /Record these in your CRM/);
  });

  it('shows n/a instead of dividing by zero', () => {
    const empty = { generated_at: TEST_NOW, registered_leads: 0, leads: [], dossiers: [], packages: [], approvals: new Map(), import_totals: { valid_rows: 0, merged_rows: 0 } };
    assert.equal(computeKpis(empty).research_completion_rate, null);
    assert.match(renderKpiReport(empty), /Research completion rate \| n\/a/);
  });

  it('keeps the latest record per lead across runs', () => {
    const runs = [{ data: [{ id: 'a', v: 1 }, { id: 'b', v: 1 }] }, { data: [{ id: 'a', v: 2 }] }];
    assert.deepEqual(latestPerKey(runs, (item) => item.id), [{ id: 'a', v: 2 }, { id: 'b', v: 1 }]);
  });

  it('treats missing review files as no decisions', async () => {
    const store = createMemoryStore();
    assert.equal((await loadPromotions(store)).latest.size, 0);
    assert.equal((await loadApprovals(store)).latest.size, 0);
  });
});

describe('command line options', () => {
  it('orders agents and requires adjacent stages', () => {
    assert.deepEqual(parseAgents('minerador'), ['minerador']);
    assert.deepEqual(parseAgents('copywriter, Pesquisador'), ['pesquisador', 'copywriter']);
    assert.deepEqual(parseAgents('minerador,pesquisador,copywriter'), ['minerador', 'pesquisador', 'copywriter']);
    assert.throws(() => parseAgents('minerador,copywriter'), /adjacent/);
    assert.throws(() => parseAgents('sender'), /accepts/);
    assert.throws(() => parseAgents(''), /accepts/);
  });
});

describe('no automatic sending', () => {
  async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)],
      ),
    );
    return nested.flat();
  }

  it('has no mail, WhatsApp or LinkedIn client in the source or the dependencies', async () => {
    const forbidden = [/nodemailer/i, /smtp/i, /sendgrid/i, /twilio/i, /graph\.facebook\.com/i, /api\.linkedin\.com/i, /wa\.me\/\d/];
    for (const file of await sourceFiles(join(process.cwd(), 'src'))) {
      const text = await readFile(file, 'utf8');
      for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
    }
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@anthropic-ai/sdk', 'zod']);
  });

  it('makes exactly one kind of outbound HTTP request: the search API', async () => {
    const callers: string[] = [];
    for (const file of await sourceFiles(join(process.cwd(), 'src'))) {
      const text = await readFile(file, 'utf8');
      if (/\bfetch\s*\(|doFetch\s*\(/.test(text)) callers.push(file.replace(/\\/g, '/').split('/src/')[1] ?? file);
    }
    assert.deepEqual(callers, ['adapters/serper.ts']);
  });
});
