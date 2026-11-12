import { decideQualification } from '../../domain/qualification.js';
import { parseCollectedAt, normalizeWebsite } from '../../domain/normalize.js';
import { buildIcpAssessment, scoreContacts, scoreGeography } from '../../domain/scoring.js';
import type { CriterionProposal } from '../../domain/scoring.js';
import { shortHash } from '../../infra/hash.js';
import type { LeadCandidate } from '../../schemas/candidate.js';
import type { QualifiedLead } from '../../schemas/lead.js';
import type {
  Confidence,
  Fact,
  Provenance,
  PublicContact,
  SourceRef,
} from '../../schemas/primitives.js';
import type { RawCompanyRecord } from '../../schemas/raw.js';
import type { ScoringConfig } from '../../schemas/settings.js';
import type { MineradorModelOutput } from './model-output.js';

/** The import source of one raw row. `url` stays null when none was collected. */
export function importSourceRef(record: RawCompanyRecord): SourceRef {
  const url = normalizeWebsite(record.input.source_url)?.url ?? null;
  return {
    url,
    source_name: record.input.source_name,
    source_type: 'import',
    retrieved_at: parseCollectedAt(record.input.collected_at) ?? record.imported_at,
    provider: null,
  };
}

function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.url ?? ''}|${source.source_name ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numbersIn(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/**
 * Guard against invented figures: a statement may only contain numbers that
 * appear in the text it claims to restate.
 */
export function numbersAreGrounded(statement: string, sourceText: string): boolean {
  const available = new Set(numbersIn(sourceText));
  return numbersIn(statement).every((value) => available.has(value));
}

function toSubSegment(value: string | null): string | null {
  if (value === null) return null;
  const slug = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? null : slug;
}

export interface AssembleContext {
  provenance: Provenance;
  now: string;
}

export interface AssembleResult {
  lead: QualifiedLead;
  /** Evidence statements dropped because they contained ungrounded numbers. */
  dropped_evidence: string[];
}

/**
 * Builds the final QualifiedLead from the candidate and the model's
 * assessment. Everything that can be decided without the model is decided
 * here: facts and their sources, contacts, geography and contact scores,
 * arithmetic, priority and qualification status.
 */
export function assembleQualifiedLead(
  candidate: LeadCandidate,
  model: MineradorModelOutput,
  scoring: ScoringConfig,
  context: AssembleContext,
): AssembleResult {
  const recordsById = new Map(candidate.records.map((record) => [record.raw_id, record]));
  const dropped: string[] = [];

  // Facts: only statements that restate the description or category of a row.
  const facts: Fact[] = [];
  const factIdByEvidenceId = new Map<string, string>();
  for (const item of model.evidence) {
    if (item.supported_by !== 'business_description' && item.supported_by !== 'business_category') {
      continue;
    }
    const field = item.supported_by;
    const supporting = candidate.records.filter((record) => record.input[field] !== null);
    if (supporting.length === 0) {
      dropped.push(item.statement);
      continue;
    }
    const sourceText = supporting.map((record) => record.input[field] ?? '').join(' ');
    if (!numbersAreGrounded(item.statement, sourceText)) {
      dropped.push(item.statement);
      continue;
    }
    const sources = uniqueSources(supporting.map(importSourceRef));
    const urls = new Set(sources.map((s) => s.url).filter((url) => url !== null));
    const factId = `fact_${shortHash([candidate.lead_id, item.statement], 12)}`;
    if (!facts.some((fact) => fact.fact_id === factId)) {
      facts.push({
        fact_id: factId,
        statement: item.statement,
        // An unsourced listing cannot be verified; it stays a hypothesis.
        kind: urls.size > 0 ? 'verified' : 'hypothesis',
        confidence: urls.size >= 2 ? 'medium' : 'low',
        sources,
      });
    }
    factIdByEvidenceId.set(item.id, factId);
  }
  const verifiedFactIds = new Set(facts.filter((f) => f.kind === 'verified').map((f) => f.fact_id));

  // Criteria: first proposal per key wins; references are mapped to real facts.
  const proposals: CriterionProposal[] = [];
  for (const criterion of model.criteria) {
    if (proposals.some((p) => p.key === criterion.key)) continue;
    const refs = criterion.evidence_ids
      .map((id) => factIdByEvidenceId.get(id))
      .filter((id): id is string => id !== undefined && verifiedFactIds.has(id));
    proposals.push({
      key: criterion.key,
      points: criterion.points,
      basis: criterion.basis,
      rationale: criterion.rationale,
      fact_refs: refs,
    });
  }
  proposals.push(scoreGeography(candidate, scoring));
  proposals.push(
    scoreContacts(
      {
        phone: candidate.contacts.some((c) => c.channel === 'phone'),
        email: candidate.contacts.some((c) => c.channel === 'email'),
        website: candidate.website !== null,
      },
      scoring,
    ),
  );
  const icp = buildIcpAssessment(proposals, scoring);

  const publicContacts: PublicContact[] = [];
  for (const contact of candidate.contacts) {
    const record = recordsById.get(contact.raw_id);
    if (record === undefined) continue;
    publicContacts.push({
      contact_id: `contact_${shortHash([candidate.lead_id, contact.channel, contact.value], 12)}`,
      channel: contact.channel,
      value: contact.value,
      scope: 'corporate',
      person_name: null,
      role_title: null,
      persona: null,
      source: importSourceRef(record),
      confidence: 'low',
    });
  }

  const sourceUrls = uniqueSources(candidate.records.map(importSourceRef)).filter(
    (source) => source.url !== null,
  );
  const confidence: Confidence = sourceUrls.length >= 2 ? 'medium' : 'low';
  const decision = decideQualification(icp, scoring, candidate.possible_duplicate_of.length > 0);

  const lead: QualifiedLead = {
    lead_id: candidate.lead_id,
    company_name: candidate.company_name,
    normalized_name: candidate.normalized_name,
    website: candidate.website,
    business_segment: model.business_segment,
    sub_segment: toSubSegment(model.sub_segment),
    city: candidate.city,
    province: candidate.province,
    country: candidate.country,
    // Verbatim from the source, never rewritten by the model.
    business_description: candidate.business_descriptions[0] ?? null,
    fleet_evidence: facts,
    public_contacts: publicContacts,
    source_urls: sourceUrls,
    icp,
    qualification_status: decision.qualification_status,
    review_reason: decision.review_reason,
    duplicate_of: null,
    merged_raw_ids: candidate.records.map((record) => record.raw_id),
    confidence,
    provenance: context.provenance,
    created_at: candidate.created_at,
    updated_at: context.now,
  };
  return { lead, dropped_evidence: dropped };
}
