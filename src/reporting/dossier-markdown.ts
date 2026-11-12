import type { ResearchDossier } from '../schemas/dossier.js';
import type { Fact, PublicContact } from '../schemas/primitives.js';

function oneLine(text: string | null): string {
  return text === null ? '' : text.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
}

function factLines(facts: readonly Fact[]): string[] {
  if (facts.length === 0) return ['None found.'];
  return facts.flatMap((fact) => [
    `- ${oneLine(fact.statement)} _(confidence: ${fact.confidence})_`,
    ...fact.sources
      .filter((source) => source.url !== null)
      .map((source) => `  - Source: ${source.url} (retrieved ${source.retrieved_at.slice(0, 10)})`),
  ]);
}

function contactRow(contact: PublicContact): string {
  return `| ${contact.channel} | ${oneLine(contact.value)} | ${oneLine(contact.person_name)} | ${oneLine(
    contact.role_title,
  )} | ${contact.confidence} | ${contact.source.url ?? oneLine(contact.source.source_name)} |`;
}

/** Renders one dossier as a readable document for the sales reviewer. */
export function renderDossierMarkdown(dossier: ResearchDossier): string {
  const lead = dossier.lead;
  const corporate = lead.public_contacts.filter((contact) => contact.scope === 'corporate');
  const people = lead.public_contacts.filter((contact) => contact.scope === 'named_person');
  const contactTable = (contacts: readonly PublicContact[]): string[] =>
    contacts.length === 0
      ? ['None found.']
      : [
          '| Channel | Value | Person | Role | Confidence | Source |',
          '| --- | --- | --- | --- | --- | --- |',
          ...contacts.map(contactRow),
        ];

  return [
    `# ${lead.company_name}`,
    '',
    `- Lead ID: \`${lead.lead_id}\``,
    `- Research status: **${dossier.research_status}**`,
    `- Identity verified: **${dossier.identity_verified ? 'yes' : 'no'}**`,
    `- Dossier confidence: **${dossier.confidence}**`,
    `- Researched: ${dossier.provenance.processed_at.slice(0, 10)} (run \`${dossier.provenance.run_id}\`)`,
    '',
    '## Company profile',
    '',
    `- Segment: ${lead.business_segment}${lead.sub_segment === null ? '' : ` (${lead.sub_segment})`}`,
    `- Location: ${[lead.city, lead.province, lead.country].filter((part) => part !== null).join(', ')}`,
    `- Website: ${lead.website ?? 'not found'}`,
    `- Description as collected: ${lead.business_description ?? 'none'}`,
    '',
    '## Identity evidence',
    '',
    ...factLines(dossier.identity_evidence),
    '',
    '## Verified findings',
    '',
    ...factLines(dossier.facts),
    '',
    '## Tools and systems observed',
    '',
    ...factLines(dossier.current_tools_observed),
    '',
    '## Possible operational challenges (hypotheses, not findings)',
    '',
    'These are topics to explore in conversation. Nothing here has been confirmed about this company.',
    '',
    ...(dossier.challenge_hypotheses.length === 0
      ? ['None proposed.']
      : dossier.challenge_hypotheses.map((h) => `- ${oneLine(h.statement)}`)),
    '',
    '## Public business contacts',
    '',
    ...contactTable(corporate),
    '',
    '## Decision-makers found publicly',
    '',
    ...contactTable(people),
    '',
    '## ICP score',
    '',
    `**${lead.icp.score} / 100**, priority ${lead.icp.priority}, coverage ${Math.round(
      lead.icp.coverage * 100,
    )}%. The score indicates potential fit, not purchase intent.`,
    '',
    '| Criterion | Points | Basis | Rationale |',
    '| --- | --- | --- | --- |',
    ...lead.icp.criteria.map(
      (c) => `| ${c.key} | ${c.points} / ${c.max} | ${c.basis} | ${oneLine(c.rationale)} |`,
    ),
    '',
    '## Recommended next action',
    '',
    oneLine(dossier.recommended_next_action),
    '',
    '## Searches run',
    '',
    ...dossier.searches.map(
      (s) => `- \`${oneLine(s.query)}\` (${s.provider}, ${s.result_count} results, ${s.retrieved_at.slice(0, 10)})`,
    ),
    '',
  ].join('\n');
}
