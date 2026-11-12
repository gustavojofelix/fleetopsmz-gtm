/**
 * Test helpers: in-memory store, scripted model client, silent logger.
 * All company data used with these helpers is fictional.
 */
import { assembleQualifiedLead } from '../src/agents/minerador/assemble.js';
import type { PesquisadorModelOutput } from '../src/agents/pesquisador/model-output.js';
import { assembleDossier } from '../src/agents/pesquisador/assemble.js';
import { numberResults } from '../src/agents/pesquisador/research-input.js';
import type { NumberedResult } from '../src/agents/pesquisador/research-input.js';
import { emptyRegistry, resolveLeads } from '../src/domain/dedupe.js';
import type { SearchProvider } from '../src/ports/search.js';
import type {
  CapabilityRegistry,
  QualifiedLead,
  ResearchDossier,
  SearchResult,
} from '../src/schemas/index.js';
import { CapabilityRegistrySchema } from '../src/schemas/index.js';
import { importRawContent } from '../src/tools/import.js';
import type { MineradorModelOutput } from '../src/agents/minerador/model-output.js';
import { loadProjectConfig } from '../src/config/project-config.js';
import type { ProjectConfig } from '../src/config/project-config.js';
import { PipelineError } from '../src/infra/errors.js';
import type { Logger } from '../src/infra/logger.js';
import type { Clock } from '../src/ports/clock.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/ports/llm.js';
import type { RecordStore } from '../src/ports/store.js';

export const TEST_RUN_ID = '2026-11-12T1840Z_k3f9a2';
export const TEST_MODEL = 'test-model';
export const TEST_PROMPT = 'Test prompt for Agent 1.';

export const fixedClock: Clock = { now: () => new Date('2026-11-12T16:40:00Z') };

export const noSleepRetry = { sleep: async (): Promise<void> => {}, random: () => 0 };

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

let cachedConfig: ProjectConfig | undefined;

/** The real files under config/, loaded once. Tests run from the project root. */
export async function loadTestConfig(): Promise<ProjectConfig> {
  cachedConfig ??= await loadProjectConfig(process.cwd());
  return cachedConfig;
}

export interface MemoryStore extends RecordStore {
  files: Map<string, string>;
}

export function createMemoryStore(initial: Record<string, string> = {}): MemoryStore {
  const files = new Map<string, string>(Object.entries(initial));
  const read = (path: string): string => {
    const content = files.get(path);
    if (content === undefined) {
      throw new PipelineError({ code: 'io', message: `Cannot read ${path}` });
    }
    return content;
  };
  return {
    files,
    exists: async (path) => files.has(path),
    readText: async (path) => read(path),
    readJson: async (path) => JSON.parse(read(path)) as unknown,
    writeNew: async (path, content) => {
      if (files.has(path)) {
        throw new PipelineError({ code: 'io', message: `Refusing to overwrite existing file: ${path}` });
      }
      files.set(path, content);
    },
    writeState: async (path, content) => {
      files.set(path, content);
    },
    appendLine: async (path, line) => {
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
    },
    list: async (directory) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${directory}/`))
        .map((path) => path.slice(directory.length + 1).split('/')[0] ?? '')
        .filter((name, index, all) => all.indexOf(name) === index)
        .sort(),
  };
}

export type ScriptedReply = object | ((request: LlmRequest) => unknown);

export interface ScriptedLlm extends LlmClient {
  requests: LlmRequest[];
}

/**
 * A model client that returns scripted replies in order. A reply that is an
 * Error is thrown; a function is called with the request. When the script runs
 * out, the last reply is repeated.
 */
export function createScriptedLlm(replies: ScriptedReply[]): ScriptedLlm {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async completeJson(request: LlmRequest): Promise<LlmResponse> {
      const index = Math.min(requests.length, replies.length - 1);
      requests.push(request);
      const scripted = replies[index];
      const reply: unknown = typeof scripted === 'function' ? scripted(request) : scripted;
      if (reply instanceof Error) throw reply;
      return {
        json: reply,
        rawText: JSON.stringify(reply),
        model: request.model,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
}

/** A valid model assessment for a transport company with a sourced description. */
export function assessment(overrides: Partial<MineradorModelOutput> = {}): MineradorModelOutput {
  return {
    business_segment: 'transport',
    sub_segment: 'Road Freight',
    evidence: [
      {
        id: 'e1',
        statement: 'Describes itself as providing cargo transport with its own trucks.',
        supported_by: 'business_description',
      },
      { id: 'e2', statement: 'The name contains "Transportes".', supported_by: 'company_name' },
    ],
    criteria: [
      { key: 'segment_relevance', points: 18, basis: 'evidence', rationale: 'Cargo transport.', evidence_ids: ['e1'] },
      { key: 'fleet_activity', points: 16, basis: 'evidence', rationale: 'Mentions own trucks.', evidence_ids: ['e1'] },
      { key: 'operational_complexity', points: 8, basis: 'inference', rationale: 'Typical for the segment.', evidence_ids: [] },
      { key: 'recurring_transport', points: 7, basis: 'inference', rationale: 'Cargo transport is recurring.', evidence_ids: ['e1'] },
      { key: 'cost_control_need', points: 7, basis: 'inference', rationale: 'Fuel-heavy business.', evidence_ids: [] },
      { key: 'digital_maturity', points: 0, basis: 'unknown', rationale: 'Nothing in the record.', evidence_ids: [] },
    ],
    notes: null,
    ...overrides,
  };
}

export const RAW_CSV_HEADER =
  'company_name,city,province,phone,email,website,business_category,business_description,source_url,source_name,collected_at';

/** Builds CSV text from rows given as partial objects keyed by column name. */
export function rawCsv(rows: Record<string, string>[]): string {
  const columns = RAW_CSV_HEADER.split(',');
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  return [RAW_CSV_HEADER, ...rows.map((row) => columns.map((c) => quote(row[c] ?? '')).join(','))].join(
    '\r\n',
  );
}

// ---------------------------------------------------------------------------
// Helpers for Agents 2 and 3
// ---------------------------------------------------------------------------

export const TEST_NOW = '2026-11-12T16:40:00.000Z';

export const SOURCED_ROW: Record<string, string> = {
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

/** Runs the real import, dedup and Agent 1 assembly to produce a qualified lead. */
export async function makeQualifiedLead(rows: Record<string, string>[] = [SOURCED_ROW]): Promise<QualifiedLead> {
  const config = await loadTestConfig();
  const records = importRawContent({ fileName: 'a.csv', content: rawCsv(rows), importedAt: TEST_NOW }).records;
  const candidate = resolveLeads(records, emptyRegistry(), config.geography, {
    run_id: TEST_RUN_ID,
    now: TEST_NOW,
  }).candidates[0];
  if (candidate === undefined) throw new Error('no candidate');
  return assembleQualifiedLead(candidate, assessment(), config.scoring, {
    now: TEST_NOW,
    provenance: {
      run_id: TEST_RUN_ID,
      agent: 'minerador',
      model: TEST_MODEL,
      prompt_version: 'v-test',
      processed_at: TEST_NOW,
    },
  }).lead;
}

export function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    provider: 'serper',
    query: 'test query',
    rank: 1,
    url: 'https://www.example.com/sobre',
    title: 'Transportes Exemplo, Lda - Sobre nós',
    snippet: 'Texto.',
    retrieved_at: TEST_NOW,
    ...overrides,
  };
}

/** Search results for the fictional company, including one about another company. */
export const RESEARCH_RESULTS: SearchResult[] = [
  searchResult({
    url: 'https://www.example.com/sobre',
    title: 'Transportes Exemplo, Lda - Sobre nós',
    snippet:
      'A Transportes Exemplo opera uma frota de 25 camiões na Beira. Contacto: geral@example.com, +258 23 320 123.',
  }),
  searchResult({
    rank: 2,
    url: 'https://directory.example.org/transportes-exemplo',
    title: 'Transportes Exemplo Lda - Beira',
    snippet: 'Empresa de transporte de carga na Beira. Director Geral: João Exemplo. Tel 84 123 4567',
  }),
  searchResult({
    rank: 3,
    url: 'https://news.example.net/artigo',
    title: 'Transportes Exemplo investe em nova frota',
    snippet: 'A Transportes Exemplo, sediada na Beira, anunciou um investimento em novos camiões.',
  }),
  searchResult({
    rank: 4,
    url: 'https://www.linkedin.com/in/joao-exemplo',
    title: 'João Exemplo - Director Geral - Transportes Exemplo',
    snippet: 'Director Geral na Transportes Exemplo, Beira.',
  }),
  searchResult({
    rank: 5,
    url: 'https://outra.example.org/modelo',
    title: 'Transportes Modelo',
    snippet: 'Outra empresa de transportes em Maputo.',
  }),
];

export function numberedResearchResults(): NumberedResult[] {
  return numberResults([RESEARCH_RESULTS]);
}

/** A model reading of RESEARCH_RESULTS that mixes grounded and ungrounded items. */
export function researchReading(overrides: Partial<PesquisadorModelOutput> = {}): PesquisadorModelOutput {
  return {
    identity: { is_same_company: true, official_website_result_id: 'r1', rationale: 'r1 and r2 name it.' },
    facts: [
      { id: 'f1', statement: 'Transportes Exemplo is a cargo transport company based in Beira.', category: 'identity', result_ids: ['r1', 'r2'] },
      { id: 'f2', statement: 'Operates a fleet of 25 trucks.', category: 'fleet', result_ids: ['r1'] },
      { id: 'f3', statement: 'Announced an investment in new trucks.', category: 'activity', result_ids: ['r3'] },
      { id: 'f4', statement: 'Operates 500 trucks across the region.', category: 'fleet', result_ids: ['r1'] },
      { id: 'f5', statement: 'Has a depot in Dondo.', category: 'location', result_ids: ['r9'] },
      { id: 'f6', statement: 'Is based in Beira.', category: 'location', result_ids: ['r2', 'r3'] },
    ],
    hypotheses: [
      { problem: 'fuel_control', statement: 'May find fuel spending hard to track across the fleet.', based_on_fact_ids: ['f2'] },
    ],
    contacts: [
      { channel: 'email', value: 'geral@example.com', person_name: null, role_title: null, persona: null, result_id: 'r1' },
      { channel: 'phone', value: '+258 23 320 123', person_name: null, role_title: null, persona: null, result_id: 'r1' },
      { channel: 'email', value: 'joao@example.com', person_name: null, role_title: null, persona: null, result_id: 'r2' },
      { channel: 'linkedin', value: 'https://www.linkedin.com/in/joao-exemplo', person_name: 'João Exemplo', role_title: 'Director Geral', persona: 'managing_director', result_id: 'r4' },
      { channel: 'phone', value: '84 123 9999', person_name: 'Maria Inventada', role_title: 'Gestora de Frota', persona: 'fleet_manager', result_id: 'r2' },
    ],
    criteria: [
      { key: 'segment_relevance', points: 19, basis: 'evidence', rationale: 'Cargo transport.', fact_ids: ['f1'] },
      { key: 'fleet_activity', points: 18, basis: 'evidence', rationale: '25 trucks.', fact_ids: ['f2'] },
      { key: 'operational_complexity', points: 9, basis: 'inference', rationale: 'Mid-size fleet.', fact_ids: [] },
      { key: 'recurring_transport', points: 7, basis: 'inference', rationale: 'Cargo transport.', fact_ids: [] },
      { key: 'cost_control_need', points: 7, basis: 'inference', rationale: 'Fuel-heavy.', fact_ids: [] },
      { key: 'digital_maturity', points: 3, basis: 'evidence', rationale: 'Own website.', fact_ids: ['f1'] },
    ],
    language: 'pt',
    recommended_next_action: 'Email the general address, then follow up by phone.',
    notes: null,
    ...overrides,
  };
}

/** Builds a complete, verified dossier through the real Agent 2 assembly. */
export async function makeDossier(reading = researchReading()): Promise<ResearchDossier> {
  const config = await loadTestConfig();
  return assembleDossier(
    await makeQualifiedLead(),
    numberedResearchResults(),
    reading,
    { scoring: config.scoring, geography: config.geography },
    {
      now: TEST_NOW,
      searches: [{ query: 'q', provider: 'serper', result_count: 5, retrieved_at: TEST_NOW }],
      provenance: {
        run_id: TEST_RUN_ID,
        agent: 'pesquisador',
        model: TEST_MODEL,
        prompt_version: 'v-test',
        processed_at: TEST_NOW,
      },
    },
  ).dossier;
}

export interface FakeSearchProvider extends SearchProvider {
  queries: string[];
}

/** A search provider returning fixed results. A reply that is an Error is thrown. */
export function createFakeSearchProvider(
  reply: (query: string) => SearchResult[] | Error = () => RESEARCH_RESULTS,
): FakeSearchProvider {
  const queries: string[] = [];
  return {
    name: 'serper',
    queries,
    async search(query) {
      queries.push(query);
      const result = reply(query);
      if (result instanceof Error) throw result;
      return result.map((item) => ({ ...item, query }));
    },
  };
}

/** Test configuration with a sender filled in, so Agent 3 can run. */
export async function loadConfigWithSender(capabilities?: CapabilityRegistry): Promise<ProjectConfig> {
  const config = await loadTestConfig();
  return {
    ...config,
    ...(capabilities === undefined ? {} : { capabilities }),
    outreach: {
      ...config.outreach,
      sender: {
        name: 'Remetente Teste',
        role: 'Director Comercial',
        company: 'FleetOps MZ',
        email: 'comercial@fleetops.example',
        phone: '+258840000000',
        website: 'https://fleetops.example',
      },
    },
  };
}

/** The shipped registry with the given capabilities marked as verified. */
export async function registryWith(
  statuses: Record<string, { status: 'implemented' | 'partially_implemented'; limitations?: string }>,
): Promise<CapabilityRegistry> {
  const { capabilities } = await loadTestConfig();
  return CapabilityRegistrySchema.parse({
    ...capabilities,
    capabilities: capabilities.capabilities.map((capability) => {
      const change = statuses[capability.key];
      return change === undefined
        ? capability
        : {
            ...capability,
            status: change.status,
            limitations: change.limitations ?? null,
            verified_by: 'Reviewer',
            verified_at: TEST_NOW,
          };
    }),
  });
}

export interface TargetSpec {
  target_id: string;
  channel: string;
  recipient_name: string | null;
}

/** Reads the <targets> block the copywriter was given. */
export function targetsIn(request: LlmRequest): TargetSpec[] {
  const match = /<targets>\n([\s\S]*?)\n<\/targets>/.exec(request.user);
  return match?.[1] === undefined ? [] : (JSON.parse(match[1]) as TargetSpec[]);
}

export const NEUTRAL_BODY =
  'Bom dia. Vi que a Transportes Exemplo é uma empresa de transporte de carga sediada na Beira. O FleetOps MZ é uma plataforma de gestão de frotas e operações de transporte, desenvolvida para empresas em Moçambique. Gostaria de marcar uma conversa breve para perceber como gerem as vossas operações.';

/** A copywriter reply with one acceptable draft per target; `edit` can break one. */
export function copyReply(
  request: LlmRequest,
  edit: (draft: Record<string, unknown>, target: TargetSpec) => Record<string, unknown> = (d) => d,
): unknown {
  return {
    drafts: targetsIn(request).map((target) =>
      edit(
        {
          target_id: target.target_id,
          subject: target.channel === 'email' ? 'Apresentação do FleetOps MZ' : null,
          body: NEUTRAL_BODY,
          call_to_action: 'Marcar uma conversa breve.',
          opt_out_line: 'Se preferir não receber mais contactos, basta responder a esta mensagem.',
          fact_ids: ['v1'],
          capability_keys: [],
        },
        target,
      ),
    ),
  };
}
