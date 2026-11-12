import type { ResearchDossier } from '../schemas/dossier.js';
import type { OutreachPackage } from '../schemas/outreach.js';
import type { StageFailure, StageSkip } from '../orchestration/stage.js';

function cell(value: string | number | null): string {
  return value === null ? '' : String(value).replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
}

function table(header: readonly string[], rows: readonly (string | number | null)[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;
}

export interface ResearchCounts {
  dossiers: number;
  complete: number;
  partial: number;
  insufficient: number;
  identity_verified: number;
  with_corporate_contact: number;
  with_named_contact: number;
  medium_or_high_confidence: number;
}

export function countDossiers(dossiers: readonly ResearchDossier[]): ResearchCounts {
  const count = (test: (d: ResearchDossier) => boolean): number => dossiers.filter(test).length;
  return {
    dossiers: dossiers.length,
    complete: count((d) => d.research_status === 'complete'),
    partial: count((d) => d.research_status === 'partial'),
    insufficient: count((d) => d.research_status === 'insufficient'),
    identity_verified: count((d) => d.identity_verified),
    with_corporate_contact: count((d) => d.lead.public_contacts.some((c) => c.scope === 'corporate')),
    with_named_contact: count((d) => d.lead.public_contacts.some((c) => c.scope === 'named_person')),
    medium_or_high_confidence: count((d) => d.confidence !== 'low'),
  };
}

interface SummaryBase {
  run_id: string;
  generated_at: string;
  model: string;
  prompt_version: string;
  failures: readonly StageFailure[];
  cache_hits: number;
  usage: { input_tokens: number; output_tokens: number };
}

function header(title: string, input: SummaryBase, extra: string[]): string[] {
  return [
    `# ${title}`,
    '',
    `- Run: \`${input.run_id}\``,
    `- Generated: ${input.generated_at}`,
    `- Model: ${input.model}`,
    `- Prompt version: ${input.prompt_version}`,
    ...extra,
    '',
  ];
}

function footer(input: SummaryBase, extraUsage: (string | number)[][] = []): string[] {
  const sections: string[] = [];
  if (input.failures.length > 0) {
    sections.push(
      '## Failures',
      '',
      table(
        ['Company', 'Error', 'Detail', 'Lead ID'],
        input.failures.map((f) => [f.company_name, f.code, f.message, `\`${f.lead_id}\``]),
      ),
      '',
    );
  }
  sections.push(
    '## Usage',
    '',
    table(
      ['Measure', 'Value'],
      [
        ...extraUsage,
        ['Model results reused from cache', input.cache_hits],
        ['Input tokens', input.usage.input_tokens],
        ['Output tokens', input.usage.output_tokens],
      ],
    ),
    '',
  );
  return sections;
}

export interface ResearchSummaryInput extends SummaryBase {
  source_run: string | null;
  dossiers: readonly ResearchDossier[];
  held: readonly StageSkip[];
  searches_run: number;
}

/** research_summary.md for one Agent 2 run. */
export function renderResearchSummary(input: ResearchSummaryInput): string {
  const counts = countDossiers(input.dossiers);
  const attempted = counts.dossiers + input.failures.length;
  const sections = header('Research summary', input, [
    `- Leads taken from qualification run: ${input.source_run === null ? 'this run' : `\`${input.source_run}\``}`,
  ]);
  sections.push(
    'Findings come from public search results (titles and snippets). Pages were not opened. Review each dossier before relying on it.',
    '',
    '## Results',
    '',
    table(
      ['Measure', 'Value'],
      [
        ['Leads sent to research', attempted],
        ['Dossiers produced', counts.dossiers],
        ['Research complete', counts.complete],
        ['Research partial', counts.partial],
        ['Research insufficient (manual research needed)', counts.insufficient],
        ['Failed', input.failures.length],
        ['Leads not researched (held or archived)', input.held.length],
        ['Research completion rate', percent(counts.complete + counts.partial, attempted)],
        ['Verified business identity', percent(counts.identity_verified, counts.dossiers)],
        ['With a public corporate contact', percent(counts.with_corporate_contact, counts.dossiers)],
        ['With a publicly named decision-maker', percent(counts.with_named_contact, counts.dossiers)],
        ['Medium or high confidence', percent(counts.medium_or_high_confidence, counts.dossiers)],
      ],
    ),
    '',
    '## Dossiers',
    '',
  );
  if (input.dossiers.length === 0) {
    sections.push('No dossiers were produced in this run.', '');
  } else {
    sections.push(
      table(
        ['Company', 'City', 'Status', 'Identity', 'Confidence', 'Score', 'Facts', 'Contacts', 'Lead ID'],
        input.dossiers.map((d) => [
          d.lead.company_name,
          d.lead.city,
          d.research_status,
          d.identity_verified ? 'verified' : 'not verified',
          d.confidence,
          d.lead.icp.score,
          d.facts.length + d.identity_evidence.length,
          d.lead.public_contacts.length,
          `\`${d.lead_id}\``,
        ]),
      ),
      '',
    );
  }
  if (input.held.length > 0) {
    sections.push(
      '## Not researched',
      '',
      'To research one of these, add a `promote` row to `data/reviews/promotions.csv` and run Agent 2 again.',
      '',
      table(
        ['Company', 'Reason', 'Lead ID'],
        input.held.map((h) => [h.company_name, h.reason, `\`${h.lead_id}\``]),
      ),
      '',
    );
  }
  sections.push(...footer(input, [['Searches run (not from cache)', input.searches_run]]));
  return sections.join('\n');
}

export interface OutreachSummaryInput extends SummaryBase {
  source_run: string | null;
  draft_type: string;
  packages: readonly { dossier: ResearchDossier; pkg: OutreachPackage }[];
  skipped: readonly StageSkip[];
}

/** outreach_summary.md for one Agent 3 run. */
export function renderOutreachSummary(input: OutreachSummaryInput): string {
  const drafts = input.packages.flatMap((p) => p.pkg.drafts);
  const byChannel = (channel: string): number => drafts.filter((d) => d.channel === channel).length;
  const sections = header('Outreach summary', input, [
    `- Dossiers taken from research run: ${input.source_run === null ? 'this run' : `\`${input.source_run}\``}`,
    `- Draft type: **${input.draft_type}**`,
  ]);
  sections.push(
    '**Nothing has been sent.** Every draft is pending human review. To approve a draft, add a row to `data/reviews/approvals.csv`, then run `npm run pipeline -- export-approved`.',
    '',
    ...(input.draft_type === 'institutional_intro'
      ? [
          'Drafts are neutral institutional introductions because no capability in `config/product-capabilities.json` is marked `implemented`. They make no product capability claims.',
          '',
        ]
      : []),
    '## Results',
    '',
    table(
      ['Measure', 'Value'],
      [
        ['Companies with drafts', input.packages.length],
        ['Drafts prepared', drafts.length],
        ['Email drafts', byChannel('email')],
        ['LinkedIn drafts', byChannel('linkedin')],
        ['WhatsApp drafts', byChannel('whatsapp')],
        ['Drafts addressed to a named person', drafts.filter((d) => d.addressed_to !== null).length],
        ['Drafts needing capability approval', drafts.filter((d) => d.requires_capability_approval).length],
        ['Drafts with review flags', drafts.filter((d) => d.review_flags.length > 0).length],
        ['Companies skipped (research not sufficient)', input.skipped.length],
        ['Failed', input.failures.length],
      ],
    ),
    '',
  );
  if (input.packages.length > 0) {
    sections.push(
      '## Drafts by company',
      '',
      table(
        ['Company', 'Drafts', 'Channels', 'Lead ID'],
        input.packages.map((p) => [
          p.dossier.lead.company_name,
          p.pkg.drafts.length,
          [...new Set(p.pkg.drafts.map((d) => d.channel))].join(', '),
          `\`${p.pkg.lead_id}\``,
        ]),
      ),
      '',
    );
  }
  if (input.skipped.length > 0) {
    sections.push(
      '## Skipped',
      '',
      table(
        ['Company', 'Reason', 'Lead ID'],
        input.skipped.map((s) => [s.company_name, s.reason, `\`${s.lead_id}\``]),
      ),
      '',
    );
  }
  sections.push(...footer(input));
  return sections.join('\n');
}
