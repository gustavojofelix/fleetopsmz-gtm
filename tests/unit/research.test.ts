import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSerperProvider } from '../../src/adapters/serper.js';
import type { RunContext } from '../../src/agents/agent.js';
import { assembleDossier, identifyingNameTokens, mentionsCompany } from '../../src/agents/pesquisador/assemble.js';
import { createPesquisadorAgent } from '../../src/agents/pesquisador/pesquisador.js';
import {
  PESQUISADOR_JSON_SCHEMA,
  PROBLEM_KEYS,
  PesquisadorModelOutputSchema,
} from '../../src/agents/pesquisador/model-output.js';
import { buildPesquisadorInput, buildResearchQueries, numberResults } from '../../src/agents/pesquisador/research-input.js';
import type { JsonCache } from '../../src/agents/structured-call.js';
import { canDraftOutreach, selectForResearch, usableFacts } from '../../src/domain/gates.js';
import { PipelineError, isPipelineError } from '../../src/infra/errors.js';
import { createRateLimiter } from '../../src/infra/rate-limiter.js';
import { ResearchDossierSchema } from '../../src/schemas/index.js';
import type { PromotionRecord, QualifiedLead } from '../../src/schemas/index.js';
import { latestDecisions, parseApprovalsCsv, parsePromotionsCsv } from '../../src/tools/reviews.js';
import { createSearchService } from '../../src/tools/search.js';
import {
  RESEARCH_RESULTS,
  TEST_MODEL,
  TEST_NOW,
  TEST_PROMPT,
  TEST_RUN_ID,
  createFakeSearchProvider,
  createScriptedLlm,
  fixedClock,
  loadTestConfig,
  makeDossier,
  makeQualifiedLead,
  noSleepRetry,
  numberedResearchResults,
  researchReading,
  searchResult,
  silentLogger,
} from '../helpers.js';

const CONTEXT: RunContext = { runId: TEST_RUN_ID, model: TEST_MODEL, logger: silentLogger, clock: fixedClock };
const noWait = async (): Promise<void> => {};
const instantLimiter = () => createRateLimiter({ minIntervalMs: 300, now: () => 0, sleep: noWait });

function memoryCache(): JsonCache & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('Serper adapter', () => {
  function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it('sends the query with the API key header and maps organic results', async () => {
    const { fetchFn, calls } = fakeFetch(200, {
      organic: [
        { title: 'A', link: 'https://a.example.com/x', snippet: 'First', position: 1 },
        { title: 'No link' },
        { title: 'Bad', link: 'not a url' },
        { link: 'https://b.example.com' },
      ],
    });
    const provider = createSerperProvider({ apiKey: 'serper-secret', fetch: fetchFn, clock: fixedClock });
    const results = await provider.search('transportes beira', { limit: 8, country: 'mz', language: 'pt' });

    assert.equal(calls[0]?.url, 'https://google.serper.dev/search');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal((calls[0]?.init.headers as Record<string, string>)['X-API-KEY'], 'serper-secret');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { q: 'transportes beira', gl: 'mz', hl: 'pt', num: 8 });
    assert.deepEqual(results, [
      { provider: 'serper', query: 'transportes beira', rank: 1, url: 'https://a.example.com/x', title: 'A', snippet: 'First', retrieved_at: TEST_NOW },
      { provider: 'serper', query: 'transportes beira', rank: 2, url: 'https://b.example.com', title: '', snippet: '', retrieved_at: TEST_NOW },
    ]);
  });

  it('returns an empty list when the response has no organic results', async () => {
    const { fetchFn } = fakeFetch(200, { searchParameters: {} });
    const provider = createSerperProvider({ apiKey: 'k', fetch: fetchFn });
    assert.deepEqual(await provider.search('q', { limit: 5, country: 'mz' }), []);
  });

  it('maps HTTP failures to structured errors that never contain the key', async () => {
    const cases: [number, string][] = [
      [429, 'rate_limited'],
      [500, 'provider_transient'],
      [401, 'provider_permanent'],
    ];
    for (const [status, code] of cases) {
      const { fetchFn } = fakeFetch(status, { message: 'x' }, { 'retry-after': '2' });
      const provider = createSerperProvider({ apiKey: 'serper-secret', fetch: fetchFn });
      await assert.rejects(provider.search('q', { limit: 5, country: 'mz' }), (error: unknown) => {
        assert.ok(isPipelineError(error));
        assert.equal(error.code, code);
        assert.equal(JSON.stringify(error.toJSON()).includes('serper-secret'), false);
        if (status === 429) assert.equal(error.retryAfterMs, 2_000);
        return true;
      });
    }
  });

  it('maps a network failure to a retryable error', async () => {
    const provider = createSerperProvider({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await assert.rejects(provider.search('q', { limit: 5, country: 'mz' }), (error: unknown) =>
      isPipelineError(error) && error.code === 'provider_transient' && error.retryable,
    );
  });
});

describe('rate limiter', () => {
  it('spaces calls by the minimum interval and keeps their order', async () => {
    let time = 1_000;
    const waits: number[] = [];
    const limiter = createRateLimiter({
      minIntervalMs: 300,
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter.schedule(async () => void order.push(n))));
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(waits, [300, 300]);
  });
});

describe('search service', () => {
  it('caches results so the provider is not called twice', async () => {
    const provider = createFakeSearchProvider();
    const cache = memoryCache();
    const service = createSearchService({ provider, limiter: instantLimiter(), logger: silentLogger, cache });
    const first = await service.search('exemplo', { limit: 8, country: 'mz' });
    const second = await service.search('exemplo', { limit: 8, country: 'mz' });
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.equal(provider.queries.length, 1);
    assert.deepEqual(second.results, first.results);
    await service.search('outro', { limit: 8, country: 'mz' });
    assert.equal(provider.queries.length, 2);
  });

  it('calls the provider again when forced', async () => {
    const provider = createFakeSearchProvider();
    const cache = memoryCache();
    const options = { provider, limiter: instantLimiter(), logger: silentLogger, cache };
    await createSearchService(options).search('exemplo', { limit: 8, country: 'mz' });
    await createSearchService({ ...options, force: true }).search('exemplo', { limit: 8, country: 'mz' });
    assert.equal(provider.queries.length, 2);
  });

  it('retries rate limits and transient failures, then succeeds', async () => {
    let calls = 0;
    const provider = createFakeSearchProvider(() => {
      calls += 1;
      return calls < 3 ? new PipelineError({ code: 'rate_limited', message: 'slow' }) : RESEARCH_RESULTS;
    });
    const service = createSearchService({ provider, limiter: instantLimiter(), logger: silentLogger, retry: noSleepRetry });
    const outcome = await service.search('exemplo', { limit: 8, country: 'mz' });
    assert.equal(outcome.results.length, 5);
    assert.equal(calls, 3);
  });

  it('gives up on a permanent failure without retrying', async () => {
    const provider = createFakeSearchProvider(() => new PipelineError({ code: 'provider_permanent', message: 'bad key' }));
    const service = createSearchService({ provider, limiter: instantLimiter(), logger: silentLogger, retry: noSleepRetry });
    await assert.rejects(service.search('exemplo', { limit: 8, country: 'mz' }));
    assert.equal(provider.queries.length, 1);
  });

  it('drops malformed results from a provider', async () => {
    const provider = createFakeSearchProvider(() => [
      searchResult(),
      { ...searchResult(), url: 'not-a-url' },
    ]);
    const service = createSearchService({ provider, limiter: instantLimiter(), logger: silentLogger });
    assert.equal((await service.search('q', { limit: 8, country: 'mz' })).results.length, 1);
  });
});

describe('research input', () => {
  it('builds four quoted queries for a company', async () => {
    const queries = buildResearchQueries(await makeQualifiedLead());
    assert.equal(queries.length, 4);
    assert.equal(queries[0], '"Transportes Exemplo, Lda" Beira');
    for (const query of queries) assert.ok(query.startsWith('"Transportes Exemplo, Lda"'));
  });

  it('numbers results and removes repeated URLs', () => {
    const numbered = numberResults([
      [searchResult({ url: 'https://a.example.com/' }), searchResult({ url: 'https://b.example.com' })],
      [searchResult({ url: 'https://A.example.com' }), searchResult({ url: 'https://c.example.com' })],
    ]);
    assert.deepEqual(numbered.map((r) => [r.id, r.url]), [
      ['r1', 'https://a.example.com/'],
      ['r2', 'https://b.example.com'],
      ['r3', 'https://c.example.com'],
    ]);
    assert.equal(numberResults([RESEARCH_RESULTS], 2).length, 2);
  });

  it('does not send contact details to the model', async () => {
    const { scoring } = await loadTestConfig();
    const text = buildPesquisadorInput(await makeQualifiedLead(), numberedResearchResults(), scoring);
    assert.match(text, /"id": "r1"/);
    assert.equal(text.includes('841234567'), false);
  });

  it('keeps the JSON schema in step with the Zod schema', () => {
    const properties = PESQUISADOR_JSON_SCHEMA['properties'] as Record<string, any>;
    assert.deepEqual(properties['hypotheses'].items.properties.problem.enum, [...PROBLEM_KEYS]);
    assert.equal(PesquisadorModelOutputSchema.safeParse(researchReading()).success, true);
  });
});

describe('mentionsCompany', () => {
  it('ignores generic words and requires the identifying ones', () => {
    assert.deepEqual(identifyingNameTokens('transportes exemplo'), ['exemplo']);
    assert.deepEqual(identifyingNameTokens('transportes mocambique'), ['transportes', 'mocambique']);
    const [official, , , , other] = numberedResearchResults();
    assert.ok(official && other);
    assert.equal(mentionsCompany('transportes exemplo', official), true);
    assert.equal(mentionsCompany('transportes exemplo', other), false);
  });

  it('accepts a match in the host name', () => {
    const [result] = numberResults([[searchResult({ url: 'https://www.exemplotransportes.co.mz', title: 'Home', snippet: '' })]]);
    assert.ok(result);
    assert.equal(mentionsCompany('transportes exemplo', result), true);
  });
});

describe('assembleDossier', () => {
  it('builds a valid, verified dossier from grounded findings', async () => {
    const dossier = await makeDossier();
    const parsed = ResearchDossierSchema.safeParse(dossier);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(dossier.identity_verified, true);
    assert.equal(dossier.research_status, 'complete');
    assert.equal(dossier.confidence, 'high');
    assert.equal(dossier.language, 'pt');
    assert.equal(dossier.recommended_next_action, 'Email the general address, then follow up by phone.');
    assert.equal(dossier.provenance.agent, 'pesquisador');
  });

  it('computes confidence from sources: official site, two domains, single source', async () => {
    const dossier = await makeDossier();
    const byStatement = (text: string) => [...dossier.identity_evidence, ...dossier.facts].find((f) => f.statement.includes(text));
    assert.equal(byStatement('cargo transport company')?.confidence, 'high');
    assert.equal(byStatement('25 trucks')?.confidence, 'high');
    assert.equal(byStatement('Is based in Beira')?.confidence, 'medium');
    assert.equal(byStatement('investment')?.confidence, 'low');
    assert.equal(byStatement('25 trucks')?.sources[0]?.source_type, 'official_site');
    assert.equal(byStatement('25 trucks')?.sources[0]?.provider, 'serper');
    assert.equal(byStatement('25 trucks')?.sources[0]?.retrieved_at, TEST_NOW);
  });

  it('drops facts with invented numbers or unknown sources', async () => {
    const dossier = await makeDossier();
    const statements = [...dossier.identity_evidence, ...dossier.facts].map((f) => f.statement);
    assert.equal(statements.some((s) => s.includes('500')), false);
    assert.equal(statements.some((s) => s.includes('Dondo')), false);
    assert.equal(statements.length, 4);
  });

  it('keeps only contacts whose value and person literally appear in the cited result', async () => {
    const dossier = await makeDossier();
    const contacts = dossier.lead.public_contacts.map((c) => [c.channel, c.value, c.scope, c.person_name]);
    assert.deepEqual(contacts, [
      ['phone', '+258841234567', 'corporate', null],
      ['email', 'geral@example.com', 'corporate', null],
      ['phone', '+25823320123', 'corporate', null],
      ['linkedin', 'https://www.linkedin.com/in/joao-exemplo', 'named_person', 'João Exemplo'],
    ]);
    const person = dossier.lead.public_contacts.find((c) => c.scope === 'named_person');
    assert.equal(person?.role_title, 'Director Geral');
    assert.equal(person?.persona, 'managing_director');
    assert.equal(dossier.lead.public_contacts.find((c) => c.value === '+25823320123')?.confidence, 'high');
  });

  it('clears a role that the cited result does not state', async () => {
    const reading = researchReading();
    reading.contacts = [
      { channel: 'linkedin', value: 'https://www.linkedin.com/in/joao-exemplo', person_name: 'João Exemplo', role_title: 'Chief Financial Officer', persona: 'finance_director', result_id: 'r4' },
    ];
    const person = (await makeDossier(reading)).lead.public_contacts.find((c) => c.scope === 'named_person');
    assert.equal(person?.person_name, 'João Exemplo');
    assert.equal(person?.role_title, null);
    assert.equal(person?.persona, null);
  });

  it('rejects a LinkedIn or website URL that is not one of the results', async () => {
    const reading = researchReading();
    reading.contacts = [
      { channel: 'linkedin', value: 'https://www.linkedin.com/in/someone-else', person_name: null, role_title: null, persona: null, result_id: 'r4' },
      { channel: 'website_form', value: 'https://outra.example.org/modelo', person_name: null, role_title: null, persona: null, result_id: 'r5' },
    ];
    const dossier = await makeDossier(reading);
    assert.equal(dossier.lead.public_contacts.length, 2);
  });

  it('re-scores the ICP on research facts and marks hypotheses as hypotheses', async () => {
    const dossier = await makeDossier();
    // 19 + 18 + 9 + 7 + 7 + 3 from the model, 15 for Beira, 5 for contact channels.
    assert.equal(dossier.lead.icp.score, 83);
    assert.equal(dossier.lead.icp.priority, 'A');
    const fleet = dossier.lead.icp.criteria.find((c) => c.key === 'fleet_activity');
    assert.equal(fleet?.basis, 'evidence');
    assert.equal(fleet?.fact_refs.length, 1);
    assert.equal(dossier.challenge_hypotheses.length, 1);
    assert.equal(dossier.challenge_hypotheses[0]?.kind, 'hypothesis');
    assert.match(dossier.challenge_hypotheses[0]?.statement ?? '', /^\[fuel_control\] May /);
    assert.equal(dossier.lead.fleet_evidence.some((f) => f.statement.includes('25 trucks')), true);
  });

  it('attaches nothing to the lead when identity is not verified', async () => {
    const lead = await makeQualifiedLead();
    const reading = researchReading();
    reading.identity.is_same_company = false;
    const dossier = await makeDossier(reading);
    assert.equal(ResearchDossierSchema.safeParse(dossier).success, true);
    assert.equal(dossier.identity_verified, false);
    assert.equal(dossier.research_status, 'insufficient');
    assert.equal(dossier.confidence, 'low');
    assert.deepEqual(dossier.lead.public_contacts, lead.public_contacts);
    assert.deepEqual(dossier.lead.icp, lead.icp);
    assert.deepEqual(dossier.lead.fleet_evidence, lead.fleet_evidence);
    assert.deepEqual(dossier.challenge_hypotheses, []);
    assert.equal(dossier.facts.every((f) => f.confidence === 'low'), true);
    assert.match(dossier.recommended_next_action, /Manual research needed/);
  });

  it('does not verify identity from results about a different company', async () => {
    const reading = researchReading();
    reading.facts = [{ id: 'f1', statement: 'Is a transport company in Maputo.', category: 'identity', result_ids: ['r5'] }];
    const dossier = await makeDossier(reading);
    assert.equal(dossier.identity_verified, false);
  });

  it('accepts a model-proposed official site only when it names the company', async () => {
    const config = await loadTestConfig();
    const lead = { ...(await makeQualifiedLead()), website: null };
    const context = {
      now: TEST_NOW,
      searches: [],
      provenance: { run_id: TEST_RUN_ID, agent: 'pesquisador' as const, model: TEST_MODEL, prompt_version: 'v', processed_at: TEST_NOW },
    };
    const accepted = assembleDossier(lead, numberedResearchResults(), researchReading(), config, context).dossier;
    assert.equal(accepted.lead.website, 'https://www.example.com');

    const wrong = researchReading();
    wrong.identity.official_website_result_id = 'r5';
    const refused = assembleDossier(lead, numberedResearchResults(), wrong, config, context).dossier;
    assert.equal(refused.lead.website, null);
    assert.equal([...refused.identity_evidence, ...refused.facts].some((f) => f.confidence === 'high'), false);

    const social = researchReading();
    social.identity.official_website_result_id = 'r4';
    assert.equal(assembleDossier(lead, numberedResearchResults(), social, config, context).dossier.lead.website, null);
  });

  it('records insufficient research when there were no results', async () => {
    const config = await loadTestConfig();
    const lead = await makeQualifiedLead();
    const { dossier } = assembleDossier(lead, [], null, config, {
      now: TEST_NOW,
      searches: [{ query: 'q', provider: 'serper', result_count: 0, retrieved_at: TEST_NOW }],
      provenance: { run_id: TEST_RUN_ID, agent: 'pesquisador', model: null, prompt_version: 'v', processed_at: TEST_NOW },
    });
    assert.equal(ResearchDossierSchema.safeParse(dossier).success, true);
    assert.equal(dossier.research_status, 'insufficient');
    assert.deepEqual(dossier.lead.icp, lead.icp);
    assert.match(dossier.recommended_next_action, /no results/);
  });
});

describe('Pesquisador agent', () => {
  async function agentWith(replies: object[], provider = createFakeSearchProvider(), cache?: JsonCache) {
    const { scoring, geography } = await loadTestConfig();
    const llm = createScriptedLlm(replies);
    const search = createSearchService({ provider, limiter: instantLimiter(), logger: silentLogger, retry: noSleepRetry });
    const agent = createPesquisadorAgent({
      llm,
      search,
      scoring,
      geography,
      prompt: TEST_PROMPT,
      retry: noSleepRetry,
      ...(cache === undefined ? {} : { cache }),
    });
    return { agent, llm, provider };
  }

  it('searches, reads the results once and returns a validated dossier', async () => {
    const { agent, llm, provider } = await agentWith([researchReading()]);
    const result = await agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(result.status, 'ok');
    assert.equal(provider.queries.length, 4);
    assert.equal(llm.requests.length, 1);
    if (result.status !== 'ok') return;
    assert.equal(result.output.searches.length, 4);
    assert.equal(result.output.searches[0]?.result_count, 5);
    assert.equal(result.output.provenance.model, TEST_MODEL);
    assert.equal(result.output.identity_verified, true);
  });

  it('does not call the model when the searches return nothing', async () => {
    const { agent, llm } = await agentWith([researchReading()], createFakeSearchProvider(() => []));
    const result = await agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(llm.requests.length, 0);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.output.research_status, 'insufficient');
      assert.equal(result.output.provenance.model, null);
    }
  });

  it('continues when one search fails and fails only when all do', async () => {
    let calls = 0;
    const flaky = createFakeSearchProvider(() => {
      calls += 1;
      return calls === 1 ? new PipelineError({ code: 'provider_permanent', message: 'bad query' }) : RESEARCH_RESULTS;
    });
    const partial = await agentWith([researchReading()], flaky);
    const ok = await partial.agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') assert.equal(ok.output.searches.length, 3);

    const down = await agentWith(
      [researchReading()],
      createFakeSearchProvider(() => new PipelineError({ code: 'provider_permanent', message: 'bad key' })),
    );
    const failed = await down.agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(failed.status, 'failed');
    if (failed.status === 'failed') assert.equal(failed.error.code, 'provider_permanent');
    assert.equal(down.llm.requests.length, 0);
  });

  it('repairs an invalid reading once and reuses a cached one', async () => {
    const cache = memoryCache();
    const first = await agentWith([{ identity: 'yes' }, researchReading()], createFakeSearchProvider(), cache);
    const result = await first.agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(result.status, 'ok');
    assert.equal(first.llm.requests.length, 2);

    const second = await agentWith([researchReading()], createFakeSearchProvider(), cache);
    const again = await second.agent.run(await makeQualifiedLead(), CONTEXT);
    assert.equal(second.llm.requests.length, 0);
    assert.equal(again.status, 'ok');
  });

  it('rejects an invalid lead without searching', async () => {
    const { agent, provider } = await agentWith([researchReading()]);
    const result = await agent.run({ lead_id: 'x' } as unknown as QualifiedLead, CONTEXT);
    assert.equal(result.status, 'failed');
    assert.equal(provider.queries.length, 0);
  });
});

describe('gates', () => {
  function promotion(lead_id: string, decision: PromotionRecord['decision']): [string, PromotionRecord] {
    return [lead_id, { lead_id, decision, reviewer: 'Reviewer', decided_at: TEST_NOW, note: null }];
  }

  it('sends qualified leads to research and holds the rest', async () => {
    const qualified = await makeQualifiedLead();
    const held: QualifiedLead = { ...qualified, lead_id: 'lead_aaaaaaaaaaaaaaaa', qualification_status: 'manual_review', review_reason: 'priority_c' };
    const low: QualifiedLead = { ...qualified, lead_id: 'lead_bbbbbbbbbbbbbbbb', qualification_status: 'low_priority' };
    const selection = selectForResearch([qualified, held, low], new Map());
    assert.deepEqual(selection.selected.map((l) => l.lead_id), [qualified.lead_id]);
    assert.deepEqual(selection.held.map((h) => h.reason), ['held for manual review (priority_c)', 'not qualified (low_priority)']);
  });

  it('follows a reviewer who promotes a held lead or archives a qualified one', async () => {
    const qualified = await makeQualifiedLead();
    const held: QualifiedLead = { ...qualified, lead_id: 'lead_aaaaaaaaaaaaaaaa', qualification_status: 'manual_review', review_reason: 'insufficient_information' };
    const selection = selectForResearch(
      [qualified, held],
      new Map([promotion(qualified.lead_id, 'archive'), promotion(held.lead_id, 'promote')]),
    );
    assert.deepEqual(selection.selected.map((l) => l.lead_id), [held.lead_id]);
    assert.equal(selection.held[0]?.reason, 'archived by a reviewer');
    const kept = selectForResearch([held], new Map([promotion(held.lead_id, 'keep_in_review')]));
    assert.equal(kept.selected.length, 0);
  });

  it('lets a solid dossier through and offers only medium or high confidence facts', async () => {
    const dossier = await makeDossier();
    assert.deepEqual(canDraftOutreach(dossier), { allowed: true, reasons: [] });
    const facts = usableFacts(dossier);
    assert.equal(facts.length, 3);
    assert.equal(facts.every((f) => f.kind === 'verified' && f.confidence !== 'low'), true);
  });

  it('blocks outreach when identity, facts or a contact channel are missing', async () => {
    const unverified = researchReading();
    unverified.identity.is_same_company = false;
    assert.deepEqual(canDraftOutreach(await makeDossier(unverified)).reasons, [
      'company identity is not verified',
      'no verified fact with high or medium confidence',
    ]);
    const dossier = await makeDossier();
    const noContact = { ...dossier, lead: { ...dossier.lead, public_contacts: [] } };
    assert.deepEqual(canDraftOutreach(noContact).reasons, ['no public corporate contact channel']);
  });
});

describe('review files', () => {
  it('reads promotions, accepting dates, and reports bad rows', () => {
    const text = [
      'lead_id,decision,reviewer,decided_at,note',
      'lead_0123456789abcdef,Promote,Gustavo,2026-11-13,looks good',
      'lead_0123456789abcdef,archive,Gustavo,2026-11-14T10:00:00Z,',
      'not-a-lead,promote,Gustavo,2026-11-13,',
      'lead_aaaaaaaaaaaaaaaa,maybe,Gustavo,2026-11-13,',
      'lead_bbbbbbbbbbbbbbbb,promote,,2026-11-13,',
    ].join('\n');
    const { records, problems } = parsePromotionsCsv(text);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.decision, 'promote');
    assert.equal(records[0]?.decided_at, '2026-11-13T00:00:00Z');
    assert.equal(problems.length, 3);
    assert.match(problems[0] ?? '', /row 4/);
    const latest = latestDecisions(records, (r) => r.lead_id);
    assert.equal(latest.get('lead_0123456789abcdef')?.decision, 'archive');
  });

  it('reads approvals and treats a header-only file as empty', () => {
    assert.deepEqual(parseApprovalsCsv('draft_id,lead_id,decision,reviewer,decided_at,note\n'), { records: [], problems: [] });
    const { records, problems } = parseApprovalsCsv(
      'draft_id;lead_id;decision;reviewer;decided_at;note\ndraft_abc123;lead_0123456789abcdef;approved;Gustavo;2026-11-13;\n',
    );
    assert.equal(problems.length, 0);
    assert.equal(records[0]?.decision, 'approved');
  });

  it('reports a file with missing columns instead of guessing', () => {
    const { records, problems } = parsePromotionsCsv('lead,decision\nx,promote\n');
    assert.equal(records.length, 0);
    assert.match(problems[0] ?? '', /missing column/);
  });
});
