import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assembleQualifiedLead, numbersAreGrounded } from '../../src/agents/minerador/assemble.js';
import { buildMineradorInput } from '../../src/agents/minerador/build-input.js';
import { createMineradorAgent, promptVersionOf } from '../../src/agents/minerador/minerador.js';
import type { AssessmentCache } from '../../src/agents/minerador/minerador.js';
import {
  MINERADOR_JSON_SCHEMA,
  MODEL_SCORED_CRITERIA,
  MineradorModelOutputSchema,
} from '../../src/agents/minerador/model-output.js';
import type { RunContext } from '../../src/agents/agent.js';
import { emptyRegistry, resolveLeads } from '../../src/domain/dedupe.js';
import { PipelineError } from '../../src/infra/errors.js';
import { QualifiedLeadSchema } from '../../src/schemas/index.js';
import type { LeadCandidate } from '../../src/schemas/index.js';
import { importRawContent } from '../../src/tools/import.js';
import {
  TEST_MODEL,
  TEST_PROMPT,
  TEST_RUN_ID,
  assessment,
  createScriptedLlm,
  fixedClock,
  loadTestConfig,
  noSleepRetry,
  rawCsv,
  silentLogger,
} from '../helpers.js';

const NOW = '2026-11-12T16:40:00Z';
const CONTEXT: RunContext = { runId: TEST_RUN_ID, model: TEST_MODEL, logger: silentLogger, clock: fixedClock };

const SOURCED_ROW = {
  company_name: 'Transportes Exemplo, Lda',
  city: 'Beira',
  phone: '84 123 4567',
  email: 'geral@example.com',
  website: 'www.example.com',
  business_category: 'Transporte de carga',
  business_description: 'Transporte de carga com camiões próprios. Frota de 12 camiões.',
  source_url: 'https://directory.example.org/transportes-exemplo',
  source_name: 'Example directory',
  collected_at: '2026-11-10',
};

async function candidateFrom(rows: Record<string, string>[]): Promise<LeadCandidate> {
  const { geography } = await loadTestConfig();
  const records = importRawContent({ fileName: 'a.csv', content: rawCsv(rows), importedAt: NOW }).records;
  const candidate = resolveLeads(records, emptyRegistry(), geography, { run_id: TEST_RUN_ID, now: NOW })
    .candidates[0];
  assert.ok(candidate);
  return candidate;
}

function assemble(candidate: LeadCandidate, model = assessment(), scoring?: never) {
  void scoring;
  return loadTestConfig().then((config) =>
    assembleQualifiedLead(candidate, model, config.scoring, {
      now: NOW,
      provenance: {
        run_id: TEST_RUN_ID,
        agent: 'minerador',
        model: TEST_MODEL,
        prompt_version: 'v-test',
        processed_at: NOW,
      },
    }),
  );
}

describe('model output schema', () => {
  it('accepts the reference assessment', () => {
    assert.equal(MineradorModelOutputSchema.safeParse(assessment()).success, true);
  });

  it('rejects code-scored criteria and unknown fields', () => {
    const withGeo = { ...assessment(), criteria: [{ key: 'geographic_relevance', points: 15, basis: 'inference', rationale: 'x', evidence_ids: [] }] };
    assert.equal(MineradorModelOutputSchema.safeParse(withGeo).success, false);
    assert.equal(MineradorModelOutputSchema.safeParse({ ...assessment(), icp_score: 90 }).success, false);
  });

  it('keeps the JSON schema enumerations in step with the Zod schema', () => {
    const properties = MINERADOR_JSON_SCHEMA['properties'] as Record<string, any>;
    assert.deepEqual(properties['criteria'].items.properties.key.enum, [...MODEL_SCORED_CRITERIA]);
    assert.deepEqual(properties['business_segment'].enum, [
      'transport',
      'logistics',
      'distribution',
      'fleet_intensive',
      'other',
    ]);
  });
});

describe('buildMineradorInput', () => {
  it('sends business fields but never phone numbers or email addresses', async () => {
    const { scoring } = await loadTestConfig();
    const text = buildMineradorInput(await candidateFrom([SOURCED_ROW]), scoring);
    assert.match(text, /Transportes Exemplo, Lda/);
    assert.match(text, /camiões próprios/);
    assert.equal(text.includes('841234567'), false);
    assert.equal(text.includes('geral@example.com'), false);
    assert.equal(text.includes('geographic_relevance'), false);
    assert.match(text, /"max_points": 20/);
  });
});

describe('numbersAreGrounded', () => {
  it('accepts numbers present in the source and rejects invented ones', () => {
    assert.equal(numbersAreGrounded('Runs 12 trucks.', 'Frota de 12 camiões.'), true);
    assert.equal(numbersAreGrounded('Runs 50 trucks.', 'Frota de 12 camiões.'), false);
    assert.equal(numbersAreGrounded('Runs trucks.', 'Frota de camiões.'), true);
  });
});

describe('assembleQualifiedLead', () => {
  it('builds a valid, qualified lead from a sourced record', async () => {
    const { lead, dropped_evidence } = await assemble(await candidateFrom([SOURCED_ROW]));
    const parsed = QualifiedLeadSchema.safeParse(lead);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(dropped_evidence, []);

    assert.equal(lead.city, 'Beira');
    assert.equal(lead.province, 'Sofala');
    assert.equal(lead.sub_segment, 'road_freight');
    assert.equal(lead.business_description, SOURCED_ROW.business_description);
    assert.equal(lead.website, 'https://www.example.com');

    // 18 + 16 + 8 + 7 + 7 + 0 from the model, 15 for Beira, 5 for three channels.
    assert.equal(lead.icp.score, 76);
    assert.equal(lead.icp.priority, 'B');
    assert.equal(lead.icp.coverage, 0.95);
    assert.equal(lead.qualification_status, 'qualified');
    assert.equal(lead.review_reason, null);
  });

  it('turns only description and category statements into sourced facts', async () => {
    const { lead } = await assemble(await candidateFrom([SOURCED_ROW]));
    assert.equal(lead.fleet_evidence.length, 1);
    const fact = lead.fleet_evidence[0];
    assert.equal(fact?.kind, 'verified');
    assert.equal(fact?.confidence, 'low');
    assert.equal(fact?.sources[0]?.url, 'https://directory.example.org/transportes-exemplo');
    assert.equal(fact?.sources[0]?.source_type, 'import');
    assert.equal(fact?.sources[0]?.retrieved_at, '2026-11-10T00:00:00Z');
    const fleet = lead.icp.criteria.find((c) => c.key === 'fleet_activity');
    assert.equal(fleet?.basis, 'evidence');
    assert.deepEqual(fleet?.fact_refs, [fact?.fact_id]);
  });

  it('records contacts as corporate, low confidence, with their import source', async () => {
    const { lead } = await assemble(await candidateFrom([SOURCED_ROW]));
    assert.deepEqual(
      lead.public_contacts.map((c) => [c.channel, c.value, c.scope, c.confidence, c.person_name]),
      [
        ['phone', '+258841234567', 'corporate', 'low', null],
        ['email', 'geral@example.com', 'corporate', 'low', null],
      ],
    );
    assert.equal(lead.source_urls.length, 1);
    assert.equal(lead.confidence, 'low');
  });

  it('drops evidence that contains a number not found in the record', async () => {
    const invented = assessment({
      evidence: [{ id: 'e1', statement: 'Operates a fleet of 50 trucks.', supported_by: 'business_description' }],
    });
    const { lead, dropped_evidence } = await assemble(await candidateFrom([SOURCED_ROW]), invented);
    assert.deepEqual(dropped_evidence, ['Operates a fleet of 50 trucks.']);
    assert.equal(lead.fleet_evidence.length, 0);
    assert.equal(lead.icp.criteria.find((c) => c.key === 'fleet_activity')?.basis, 'inference');
    assert.equal(QualifiedLeadSchema.safeParse(lead).success, true);
  });

  it('treats statements from an unsourced record as hypotheses, not evidence', async () => {
    const unsourced = { ...SOURCED_ROW, source_url: '', source_name: '' };
    const { lead } = await assemble(await candidateFrom([unsourced]));
    assert.equal(lead.fleet_evidence[0]?.kind, 'hypothesis');
    assert.equal(lead.icp.criteria.find((c) => c.key === 'fleet_activity')?.basis, 'inference');
    assert.deepEqual(lead.source_urls, []);
    assert.equal(QualifiedLeadSchema.safeParse(lead).success, true);
  });

  it('holds a name-only record for review instead of rejecting it', async () => {
    const sparse = assessment({
      business_segment: 'other',
      sub_segment: null,
      evidence: [],
      criteria: MODEL_SCORED_CRITERIA.map((key) => ({
        key,
        points: 0,
        basis: 'unknown' as const,
        rationale: 'Nothing in the record.',
        evidence_ids: [],
      })),
    });
    const { lead } = await assemble(await candidateFrom([{ company_name: 'Exemplo Lda' }]), sparse);
    assert.equal(lead.icp.score, 0);
    assert.equal(lead.icp.coverage, 0);
    assert.equal(lead.qualification_status, 'manual_review');
    assert.equal(lead.review_reason, 'insufficient_information');
    assert.equal(lead.city, null);
    assert.equal(lead.website, null);
    assert.equal(lead.business_description, null);
    assert.equal(QualifiedLeadSchema.safeParse(lead).success, true);
  });

  it('raises confidence to medium when two sources list the company', async () => {
    const second = { ...SOURCED_ROW, source_url: 'https://other.example.net/exemplo', source_name: 'Other' };
    const { lead } = await assemble(await candidateFrom([SOURCED_ROW, second]));
    assert.equal(lead.merged_raw_ids.length, 2);
    assert.equal(lead.source_urls.length, 2);
    assert.equal(lead.confidence, 'medium');
    assert.equal(lead.fleet_evidence[0]?.confidence, 'medium');
  });
});

describe('Minerador agent', () => {
  async function agentWith(replies: object[], cache?: AssessmentCache, force = false) {
    const { scoring } = await loadTestConfig();
    const llm = createScriptedLlm(replies);
    const agent = createMineradorAgent({
      llm,
      scoring,
      prompt: TEST_PROMPT,
      retry: noSleepRetry,
      force,
      ...(cache === undefined ? {} : { cache }),
    });
    return { agent, llm };
  }

  function memoryCache(): AssessmentCache & { entries: Map<string, unknown> } {
    const entries = new Map<string, unknown>();
    return {
      entries,
      get: async (key) => entries.get(key) ?? null,
      set: async (key, value) => {
        entries.set(key, value);
      },
    };
  }

  it('returns a validated lead with provenance and usage', async () => {
    const { agent, llm } = await agentWith([assessment()]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.provenance.agent, 'minerador');
    assert.equal(result.output.provenance.model, TEST_MODEL);
    assert.equal(result.output.provenance.prompt_version, promptVersionOf(TEST_PROMPT));
    assert.equal(result.output.provenance.run_id, TEST_RUN_ID);
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 50 });
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0]?.system, TEST_PROMPT);
    assert.ok(llm.requests[0]?.jsonSchema);
  });

  it('repairs an invalid reply once, telling the model what was wrong', async () => {
    const { agent, llm } = await agentWith([{ business_segment: 'trucking' }, assessment()]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'ok');
    assert.equal(llm.requests.length, 2);
    assert.match(llm.requests[1]?.user ?? '', /previous reply was rejected/);
    assert.match(llm.requests[1]?.user ?? '', /business_segment/);
    if (result.status === 'ok') {
      assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 100 });
    }
  });

  it('fails the record after one unsuccessful repair, without a third call', async () => {
    const { agent, llm } = await agentWith([{ nonsense: true }]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'model_output_invalid');
    assert.equal(llm.requests.length, 2);
  });

  it('retries transient provider errors, then succeeds', async () => {
    const transient = new PipelineError({ code: 'provider_transient', message: 'down' });
    const { agent, llm } = await agentWith([transient, transient, assessment()]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'ok');
    assert.equal(llm.requests.length, 3);
  });

  it('returns a failure, not an exception, when the provider keeps failing', async () => {
    const { agent, llm } = await agentWith([new PipelineError({ code: 'rate_limited', message: 'slow' })]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'rate_limited');
    assert.equal(llm.requests.length, 3);
  });

  it('does not retry a permanent provider error', async () => {
    const { agent, llm } = await agentWith([new PipelineError({ code: 'provider_permanent', message: 'bad key' })]);
    const result = await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(result.status, 'failed');
    assert.equal(llm.requests.length, 1);
  });

  it('rejects an invalid candidate without calling the model', async () => {
    const { agent, llm } = await agentWith([assessment()]);
    const result = await agent.run({ lead_id: 'x' } as unknown as LeadCandidate, CONTEXT);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'input_validation');
    assert.equal(llm.requests.length, 0);
  });

  it('reuses a cached assessment instead of calling the model again', async () => {
    const cache = memoryCache();
    const candidate = await candidateFrom([SOURCED_ROW]);
    const first = await agentWith([assessment()], cache);
    await first.agent.run(candidate, CONTEXT);
    assert.equal(cache.entries.size, 1);

    const second = await agentWith([assessment()], cache);
    const result = await second.agent.run(candidate, CONTEXT);
    assert.equal(second.llm.requests.length, 0);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.fromCache, true);
      assert.equal(result.usage, null);
    }
  });

  it('ignores the cache when forced, when the model changes or when the record changes', async () => {
    const cache = memoryCache();
    const candidate = await candidateFrom([SOURCED_ROW]);
    await (await agentWith([assessment()], cache)).agent.run(candidate, CONTEXT);

    const forced = await agentWith([assessment()], cache, true);
    await forced.agent.run(candidate, CONTEXT);
    assert.equal(forced.llm.requests.length, 1);

    const otherModel = await agentWith([assessment()], cache);
    await otherModel.agent.run(candidate, { ...CONTEXT, model: 'another-model' });
    assert.equal(otherModel.llm.requests.length, 1);

    const changed = await candidateFrom([{ ...SOURCED_ROW, business_description: 'Aluguer de viaturas.' }]);
    const otherRecord = await agentWith([assessment()], cache);
    await otherRecord.agent.run(changed, CONTEXT);
    assert.equal(otherRecord.llm.requests.length, 1);
  });

  it('does not cache an invalid reply', async () => {
    const cache = memoryCache();
    const { agent } = await agentWith([{ nonsense: true }], cache);
    await agent.run(await candidateFrom([SOURCED_ROW]), CONTEXT);
    assert.equal(cache.entries.size, 0);
  });
});
