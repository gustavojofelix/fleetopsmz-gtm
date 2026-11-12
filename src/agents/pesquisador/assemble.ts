import {
  comparisonKey,
  domainOf,
  isSharedWebDomain,
  normalizeEmail,
  normalizePhone,
  resolveLocation,
} from '../../domain/normalize.js';
import { buildIcpAssessment, scoreContacts, scoreGeography } from '../../domain/scoring.js';
import type { CriterionProposal } from '../../domain/scoring.js';
import { shortHash } from '../../infra/hash.js';
import type { ResearchDossier, ResearchStatus } from '../../schemas/dossier.js';
import type { QualifiedLead } from '../../schemas/lead.js';
import type {
  Confidence,
  Fact,
  Provenance,
  PublicContact,
  SourceRef,
  SourceType,
} from '../../schemas/primitives.js';
import type { GeographyConfig, ScoringConfig } from '../../schemas/settings.js';
import { numbersAreGrounded } from '../minerador/assemble.js';
import type { PesquisadorModelOutput } from './model-output.js';
import type { NumberedResult } from './research-input.js';

/** Words too common in company names to identify a company on their own. */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  'transportes', 'transporte', 'transportadora', 'logistica', 'logistics', 'servicos', 'services',
  'comercio', 'comercial', 'empresa', 'grupo', 'group', 'mocambique', 'mozambique', 'carga', 'cargas',
  'cargo', 'distribuicao', 'distribuidora', 'construcoes', 'construcao', 'internacional', 'international',
  'trading', 'company', 'e', 'de', 'da', 'do', 'dos', 'das', 'the', 'and',
]);

function resultText(result: NumberedResult): string {
  return `${result.title} ${result.snippet}`;
}

/** The name tokens that must appear for a page to be about this company. */
export function identifyingNameTokens(normalizedName: string): string[] {
  const tokens = normalizedName.split(' ').filter((token) => token !== '');
  const specific = tokens.filter((token) => !GENERIC_NAME_TOKENS.has(token));
  return specific.length > 0 ? specific : tokens;
}

/**
 * Checks, without the model, that a search result mentions the company: every
 * identifying name token must appear in its title, snippet or host name.
 */
export function mentionsCompany(normalizedName: string, result: NumberedResult): boolean {
  const tokens = identifyingNameTokens(normalizedName);
  if (tokens.length === 0) return false;
  const host = domainOf(result.url) ?? '';
  const words = ` ${comparisonKey(`${resultText(result)} ${host}`)} `;
  const hostLetters = host.replace(/[^a-z0-9]/g, '');
  return tokens.every((token) => words.includes(` ${token} `) || hostLetters.includes(token));
}

function classifySource(domain: string | null, officialDomain: string | null): SourceType {
  if (domain === null) return 'other';
  if (officialDomain !== null && (domain === officialDomain || domain.endsWith(`.${officialDomain}`))) {
    return 'official_site';
  }
  if (isSharedWebDomain(domain)) return 'social';
  if (domain.endsWith('.gov.mz')) return 'government';
  return 'other';
}

function sourceOf(result: NumberedResult, officialDomain: string | null): SourceRef {
  return {
    url: result.url,
    source_name: result.title.trim() === '' ? null : result.title.trim(),
    source_type: classifySource(domainOf(result.url), officialDomain),
    retrieved_at: result.retrieved_at,
    provider: result.provider,
  };
}

function confidenceOf(sources: readonly SourceRef[]): Confidence {
  if (sources.some((source) => source.source_type === 'official_site')) return 'high';
  const domains = new Set(sources.map((s) => (s.url === null ? null : domainOf(s.url))));
  domains.delete(null);
  return domains.size >= 2 ? 'medium' : 'low';
}

function sameUrl(a: string, b: string): boolean {
  const clean = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

function mergeSources(...lists: readonly (readonly SourceRef[])[]): SourceRef[] {
  const seen = new Set<string>();
  const merged: SourceRef[] = [];
  for (const source of lists.flat()) {
    const key = source.url ?? `name:${source.source_name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

export interface DossierContext {
  provenance: Provenance;
  now: string;
  searches: ResearchDossier['searches'];
}

export interface DossierAssembly {
  dossier: ResearchDossier;
  /** Model statements and contacts removed because they were not grounded. */
  dropped: { facts: number; contacts: number };
}

/**
 * Builds the dossier from the model's reading of the search results. Nothing
 * from the model is trusted as given:
 * - a fact survives only if it cites real results and contains no number
 *   absent from them; its confidence is computed from its sources;
 * - a contact survives only if its value, and any person's name, literally
 *   appear in the result it cites;
 * - identity is verified only if a cited result demonstrably names the company.
 *
 * `model` is null when the searches returned nothing: the dossier then records
 * that research was insufficient.
 */
export function assembleDossier(
  lead: QualifiedLead,
  results: readonly NumberedResult[],
  model: PesquisadorModelOutput | null,
  config: { scoring: ScoringConfig; geography: GeographyConfig },
  context: DossierContext,
): DossierAssembly {
  const byId = new Map(results.map((result) => [result.id, result]));
  const dropped = { facts: 0, contacts: 0 };

  // Official website: the one already known, or one the model points at that
  // is the company's own domain and names the company.
  let officialDomain = lead.website === null ? null : domainOf(lead.website);
  if (officialDomain !== null && isSharedWebDomain(officialDomain)) officialDomain = null;
  let website = lead.website;
  const proposedSite =
    model?.identity.official_website_result_id == null
      ? undefined
      : byId.get(model.identity.official_website_result_id);
  if (officialDomain === null && proposedSite !== undefined) {
    const domain = domainOf(proposedSite.url);
    if (domain !== null && !isSharedWebDomain(domain) && mentionsCompany(lead.normalized_name, proposedSite)) {
      officialDomain = domain;
      website = `https://${new URL(proposedSite.url).hostname.toLowerCase()}`;
    }
  }

  // Facts.
  const facts: (Fact & { category: string; model_id: string; cited: NumberedResult[] })[] = [];
  for (const item of model?.facts ?? []) {
    const cited = item.result_ids
      .map((id) => byId.get(id))
      .filter((result): result is NumberedResult => result !== undefined);
    const text = cited.map(resultText).join(' ');
    if (cited.length === 0 || !numbersAreGrounded(item.statement, text)) {
      dropped.facts += 1;
      continue;
    }
    const sources = mergeSources(cited.map((result) => sourceOf(result, officialDomain)));
    facts.push({
      fact_id: `fact_${shortHash([lead.lead_id, 'research', item.statement], 12)}`,
      statement: item.statement,
      kind: 'verified',
      confidence: confidenceOf(sources),
      sources,
      category: item.category,
      model_id: item.id,
      cited,
    });
  }

  const identityFacts = facts.filter((fact) => fact.category === 'identity');
  const identityVerified =
    model?.identity.is_same_company === true &&
    identityFacts.some((fact) => fact.cited.some((r) => mentionsCompany(lead.normalized_name, r)));

  const toFact = (fact: (typeof facts)[number]): Fact => ({
    fact_id: fact.fact_id,
    statement: fact.statement,
    kind: fact.kind,
    // Until identity is verified, a fact may be about a different company.
    confidence: identityVerified ? fact.confidence : 'low',
    sources: fact.sources,
  });
  const uniqueFacts = (list: typeof facts): Fact[] => {
    const seen = new Set<string>();
    return list.filter((f) => !seen.has(f.fact_id) && seen.add(f.fact_id)).map(toFact);
  };
  const factIdByModelId = new Map(facts.map((fact) => [fact.model_id, fact.fact_id]));

  // Contacts.
  const contacts: PublicContact[] = [...lead.public_contacts];
  const contactKey = (c: { channel: string; value: string }): string => `${c.channel}:${c.value.toLowerCase()}`;
  const known = new Set(contacts.map(contactKey));
  for (const item of model?.contacts ?? []) {
    const result = byId.get(item.result_id);
    if (result === undefined) {
      dropped.contacts += 1;
      continue;
    }
    const text = resultText(result);
    const digits = text.replace(/\D/g, '');
    let value: string | null = null;
    if (item.channel === 'email') {
      const email = normalizeEmail(item.value);
      if (email !== null && text.toLowerCase().includes(email.address)) value = email.address;
    } else if (item.channel === 'phone' || item.channel === 'whatsapp') {
      const phone = normalizePhone(item.value);
      const core = phone === null ? '' : phone.startsWith('+258') ? phone.slice(4) : phone.slice(1);
      if (phone !== null && core.length >= 8 && digits.includes(core)) value = phone;
    } else {
      const domain = domainOf(item.value);
      const isResultUrl = results.some((r) => sameUrl(r.url, item.value));
      const allowed =
        item.channel === 'linkedin'
          ? domain !== null && (domain === 'linkedin.com' || domain.endsWith('.linkedin.com'))
          : domain !== null && domain === officialDomain;
      if (isResultUrl && allowed) value = item.value.trim();
    }
    let personName = item.person_name;
    if (personName !== null && !comparisonKey(text).includes(comparisonKey(personName))) {
      // An ungrounded name is never recorded, and neither is the contact tied to it.
      value = null;
      personName = null;
    }
    if (value === null) {
      dropped.contacts += 1;
      continue;
    }
    const roleGrounded =
      personName !== null &&
      item.role_title !== null &&
      comparisonKey(text).includes(comparisonKey(item.role_title));
    const candidate = { channel: item.channel, value };
    if (known.has(contactKey(candidate))) continue;
    known.add(contactKey(candidate));

    const source = sourceOf(result, officialDomain);
    const needle = item.channel === 'email' ? value : value.replace(/\D/g, '').slice(-8);
    const domainsMentioning = new Set(
      results
        .filter((r) =>
          item.channel === 'email'
            ? resultText(r).toLowerCase().includes(needle)
            : needle.length >= 8 && resultText(r).replace(/\D/g, '').includes(needle),
        )
        .map((r) => domainOf(r.url)),
    );
    contacts.push({
      contact_id: `contact_${shortHash([lead.lead_id, item.channel, value], 12)}`,
      channel: item.channel,
      value,
      scope: personName === null ? 'corporate' : 'named_person',
      person_name: personName,
      role_title: roleGrounded ? item.role_title : null,
      persona: roleGrounded ? item.persona : null,
      source,
      confidence:
        source.source_type === 'official_site' ? 'high' : domainsMentioning.size >= 2 ? 'medium' : 'low',
    });
  }

  // Contacts and website found for an unverified identity may belong to
  // another company, so they are not attached to the lead.
  const finalContacts = identityVerified ? contacts : lead.public_contacts;
  const finalWebsite = identityVerified ? website : lead.website;

  // ICP, re-scored on research facts.
  const verifiedIds = new Set(facts.map((fact) => fact.fact_id));
  const proposals: CriterionProposal[] = [];
  for (const criterion of model?.criteria ?? []) {
    if (proposals.some((p) => p.key === criterion.key)) continue;
    proposals.push({
      key: criterion.key,
      points: criterion.points,
      basis: criterion.basis,
      rationale: criterion.rationale,
      fact_refs: criterion.fact_ids
        .map((id) => factIdByModelId.get(id))
        .filter((id): id is string => id !== undefined && verifiedIds.has(id)),
    });
  }
  const location = resolveLocation(lead.city, lead.province, config.geography);
  const hasChannel = (channels: readonly string[]): boolean =>
    finalContacts.some((contact) => channels.includes(contact.channel));
  const icp =
    model === null || !identityVerified
      ? lead.icp
      : buildIcpAssessment(
          [
            ...proposals,
            scoreGeography(
              {
                city: location.city,
                province: location.province,
                location_listed: location.listed,
                priority_rank: location.priority_rank,
              },
              config.scoring,
            ),
            scoreContacts(
              {
                phone: hasChannel(['phone', 'whatsapp']),
                email: hasChannel(['email']),
                website: finalWebsite !== null,
              },
              config.scoring,
            ),
          ],
          config.scoring,
        );

  const researchFacts = uniqueFacts(facts.filter((fact) => fact.category !== 'identity'));
  const identityEvidence = uniqueFacts(identityFacts);
  const hypotheses: Fact[] = (model?.hypotheses ?? []).map((item) => ({
    fact_id: `fact_${shortHash([lead.lead_id, 'hypothesis', item.problem, item.statement], 12)}`,
    statement: `[${item.problem}] ${item.statement}`,
    kind: 'hypothesis',
    confidence: 'low',
    sources: [],
  }));

  const usable = [...identityEvidence, ...researchFacts].some((fact) => fact.confidence !== 'low');
  const corporateChannel = finalContacts.some((contact) => contact.scope === 'corporate');
  const status: ResearchStatus =
    !identityVerified || researchFacts.length + identityEvidence.length === 0
      ? 'insufficient'
      : usable && corporateChannel
        ? 'complete'
        : 'partial';
  const confidence: Confidence = !identityVerified
    ? 'low'
    : identityEvidence.some((fact) => fact.confidence === 'high')
      ? 'high'
      : identityEvidence.some((fact) => fact.confidence === 'medium')
        ? 'medium'
        : 'low';

  const fleetFacts = uniqueFacts(facts.filter((fact) => fact.category === 'fleet'));
  const existingFleetIds = new Set(lead.fleet_evidence.map((fact) => fact.fact_id));
  const updatedLead: QualifiedLead = {
    ...lead,
    website: finalWebsite,
    fleet_evidence: [
      ...lead.fleet_evidence,
      ...(identityVerified ? fleetFacts.filter((fact) => !existingFleetIds.has(fact.fact_id)) : []),
    ],
    public_contacts: finalContacts,
    source_urls: mergeSources(
      lead.source_urls,
      identityVerified ? [...identityEvidence, ...researchFacts].flatMap((fact) => fact.sources) : [],
    ),
    icp,
    confidence: identityVerified && confidence !== 'low' ? confidence : lead.confidence,
    updated_at: context.now,
  };

  const dossier: ResearchDossier = {
    lead_id: lead.lead_id,
    lead: updatedLead,
    identity_verified: identityVerified,
    identity_evidence: identityEvidence,
    facts: researchFacts.filter((fact) => !fleetFacts.some((f) => f.fact_id === fact.fact_id)).concat(fleetFacts),
    challenge_hypotheses: identityVerified ? hypotheses : [],
    current_tools_observed: uniqueFacts(facts.filter((fact) => fact.category === 'tools')),
    language: model?.language ?? 'pt',
    searches: context.searches,
    research_status: status,
    recommended_next_action:
      model === null
        ? 'Manual research needed: the searches returned no results for this company.'
        : !identityVerified
          ? 'Manual research needed: public search results did not confirm the company identity.'
          : model.recommended_next_action,
    confidence,
    provenance: context.provenance,
  };
  return { dossier, dropped };
}
