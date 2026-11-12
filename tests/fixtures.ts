/**
 * Shared test fixtures. Every company, person and URL here is fictional
 * (example.com is a reserved domain) and must never be used as real data.
 */

export const RUN_ID = '2026-11-12T1840Z_k3f9a2';
export const LEAD_ID = 'lead_0123456789abcdef';
export const NOW = '2026-11-12T16:40:00Z';

export function sourceRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://www.example.com/sobre',
    source_name: 'Example official site',
    source_type: 'official_site',
    retrieved_at: NOW,
    provider: 'serper',
    ...overrides,
  };
}

export function fact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fact_id: 'fact_abc123',
    statement: 'Operates a fleet of heavy trucks for container transport.',
    kind: 'verified',
    confidence: 'high',
    sources: [sourceRef()],
    ...overrides,
  };
}

export function contact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contact_id: 'contact_abc123',
    channel: 'email',
    value: 'geral@example.com',
    scope: 'corporate',
    person_name: null,
    role_title: null,
    persona: null,
    source: sourceRef(),
    confidence: 'high',
    ...overrides,
  };
}

export function provenance(agent: string): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    agent,
    model: 'test-model',
    prompt_version: 'v1',
    processed_at: NOW,
  };
}

const CRITERIA: ReadonlyArray<readonly [string, number, number]> = [
  ['segment_relevance', 20, 18],
  ['fleet_activity', 20, 16],
  ['operational_complexity', 15, 10],
  ['geographic_relevance', 15, 15],
  ['recurring_transport', 10, 8],
  ['cost_control_need', 10, 6],
  ['contact_availability', 5, 5],
  ['digital_maturity', 5, 0],
];

/** A valid ICP assessment totalling 78 points (priority B). */
export function icp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    criteria: CRITERIA.map(([key, max, points]) => ({
      key,
      max,
      points,
      basis: key === 'digital_maturity' ? 'unknown' : 'evidence',
      rationale: `Rationale for ${key}.`,
      fact_refs: key === 'digital_maturity' ? [] : ['fact_abc123'],
    })),
    score: 78,
    coverage: 0.95,
    priority: 'B',
    ...overrides,
  };
}

export function qualifiedLead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lead_id: LEAD_ID,
    company_name: 'Transportes Exemplo, Lda',
    normalized_name: 'transportes exemplo',
    website: 'https://www.example.com',
    business_segment: 'transport',
    sub_segment: 'container_transport',
    city: 'Beira',
    province: 'Sofala',
    country: 'Mozambique',
    business_description: null,
    fleet_evidence: [fact()],
    public_contacts: [contact()],
    source_urls: [sourceRef()],
    icp: icp(),
    qualification_status: 'qualified',
    review_reason: null,
    duplicate_of: null,
    merged_raw_ids: ['raw_0123456789abcdef'],
    confidence: 'high',
    provenance: provenance('minerador'),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function dossier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lead_id: LEAD_ID,
    lead: qualifiedLead(),
    identity_verified: true,
    identity_evidence: [fact({ fact_id: 'fact_ident01', statement: 'Official site lists the company in Beira.' })],
    facts: [fact()],
    challenge_hypotheses: [
      fact({
        fact_id: 'fact_hypo001',
        statement: 'May track trips manually.',
        kind: 'hypothesis',
        confidence: 'low',
        sources: [],
      }),
    ],
    current_tools_observed: [],
    language: 'pt',
    searches: [{ query: 'Transportes Exemplo Beira', provider: 'serper', result_count: 8, retrieved_at: NOW }],
    research_status: 'complete',
    recommended_next_action: 'Prepare outreach to corporate email.',
    confidence: 'high',
    provenance: provenance('pesquisador'),
    ...overrides,
  };
}

export function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: 'draft_abc123',
    draft_type: 'institutional_intro',
    persona: 'managing_director',
    addressed_to: null,
    contact_id: 'contact_abc123',
    channel: 'email',
    language: 'pt',
    subject: 'Apresentação institucional',
    body: 'Texto de exemplo para testes.',
    call_to_action: 'Pedido de uma conversa breve.',
    opt_out_line: 'Se preferir não receber mais contactos, basta responder a esta mensagem.',
    fact_refs: ['fact_abc123'],
    capability_refs: [],
    requires_capability_approval: false,
    review_flags: [],
    ...overrides,
  };
}

export function outreachPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lead_id: LEAD_ID,
    drafts: [draft()],
    approval: { status: 'pending_human_review' },
    provenance: provenance('copywriter'),
    ...overrides,
  };
}

export function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'trips',
    name_en: 'Trip management',
    name_pt: 'Gestão de viagens',
    status: 'unverified',
    limitations: null,
    verified_by: null,
    verified_at: null,
    keywords: ['viagens'],
    notes: null,
    ...overrides,
  };
}

export function capabilityRegistry(capabilities: Record<string, unknown>[]): Record<string, unknown> {
  return { schema_version: 1, updated_at: null, capabilities };
}
