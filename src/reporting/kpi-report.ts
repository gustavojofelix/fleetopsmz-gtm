import type {
  ApprovalRecord,
  OutreachPackage,
  QualifiedLead,
  ResearchDossier,
} from '../schemas/index.js';

export interface KpiInput {
  generated_at: string;
  /** Companies in the lead registry. */
  registered_leads: number;
  /** Latest qualification record per lead, across all runs. */
  leads: readonly QualifiedLead[];
  /** Latest dossier per lead, across all runs. */
  dossiers: readonly ResearchDossier[];
  /** Latest outreach package per lead, across all runs. */
  packages: readonly OutreachPackage[];
  /** Latest decision per draft. */
  approvals: ReadonlyMap<string, ApprovalRecord>;
  /** Totals over all qualification runs, for the duplicate rate. */
  import_totals: { valid_rows: number; merged_rows: number };
}

export interface Kpis {
  companies_discovered: number;
  companies_assessed: number;
  companies_qualified: number;
  priority_a: number;
  priority_b: number;
  held_for_review: number;
  researched: number;
  research_completion_rate: number | null;
  verified_identity_rate: number | null;
  verified_business_contact_rate: number | null;
  drafts_prepared: number;
  drafts_approved: number;
  drafts_rejected: number;
  drafts_changes_requested: number;
  drafts_pending: number;
  duplicate_rate: number | null;
  with_source_url_rate: number | null;
  medium_or_high_confidence_rate: number | null;
  substantial_correction_rate: number | null;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
}

/** Computes the KPIs this system can measure from its own data. */
export function computeKpis(input: KpiInput): Kpis {
  const count = <T>(items: readonly T[], test: (item: T) => boolean): number => items.filter(test).length;
  const drafts = input.packages.flatMap((pkg) => pkg.drafts);
  const decisionOf = (draftId: string): string | undefined => input.approvals.get(draftId)?.decision;
  const approved = count(drafts, (d) => decisionOf(d.draft_id) === 'approved');
  const rejected = count(drafts, (d) => decisionOf(d.draft_id) === 'rejected');
  const changes = count(drafts, (d) => decisionOf(d.draft_id) === 'changes_requested');
  const decided = approved + rejected + changes;

  return {
    companies_discovered: input.registered_leads,
    companies_assessed: input.leads.length,
    companies_qualified: count(input.leads, (l) => l.qualification_status === 'qualified'),
    priority_a: count(input.leads, (l) => l.icp.priority === 'A'),
    priority_b: count(input.leads, (l) => l.icp.priority === 'B'),
    held_for_review: count(input.leads, (l) => l.qualification_status === 'manual_review'),
    researched: input.dossiers.length,
    research_completion_rate: rate(
      count(input.dossiers, (d) => d.research_status !== 'insufficient'),
      input.dossiers.length,
    ),
    verified_identity_rate: rate(count(input.dossiers, (d) => d.identity_verified), input.dossiers.length),
    verified_business_contact_rate: rate(
      count(
        input.dossiers,
        (d) => d.identity_verified && d.lead.public_contacts.some((c) => c.scope === 'corporate'),
      ),
      input.dossiers.length,
    ),
    drafts_prepared: drafts.length,
    drafts_approved: approved,
    drafts_rejected: rejected,
    drafts_changes_requested: changes,
    drafts_pending: drafts.length - decided,
    duplicate_rate: rate(input.import_totals.merged_rows, input.import_totals.valid_rows),
    with_source_url_rate: rate(count(input.leads, (l) => l.source_urls.length > 0), input.leads.length),
    medium_or_high_confidence_rate: rate(count(input.leads, (l) => l.confidence !== 'low'), input.leads.length),
    substantial_correction_rate: rate(rejected + changes, decided),
  };
}

function show(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function table(rows: readonly (readonly [string, string | number])[]): string {
  return ['| KPI | Value |', '| --- | --- |', ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join(
    '\n',
  );
}

/** Renders the KPI report. Later sales stages are tracked outside this system. */
export function renderKpiReport(input: KpiInput): string {
  const k = computeKpis(input);
  return [
    '# FleetOps MZ pipeline KPIs',
    '',
    `Generated: ${input.generated_at}`,
    '',
    'Figures use the most recent record of each company across all runs.',
    '',
    '## Acquisition',
    '',
    table([
      ['Companies discovered', k.companies_discovered],
      ['Companies assessed', k.companies_assessed],
      ['Companies qualified', k.companies_qualified],
      ['Priority A', k.priority_a],
      ['Priority B', k.priority_b],
      ['Held for manual review', k.held_for_review],
      ['Companies researched', k.researched],
      ['Research completion rate', show(k.research_completion_rate)],
      ['Verified business contact rate', show(k.verified_business_contact_rate)],
      ['Outreach messages prepared', k.drafts_prepared],
      ['Outreach messages approved', k.drafts_approved],
      ['Outreach messages rejected', k.drafts_rejected],
      ['Outreach messages with changes requested', k.drafts_changes_requested],
      ['Outreach messages awaiting review', k.drafts_pending],
    ]),
    '',
    '## Quality',
    '',
    table([
      ['Duplicate rate (rows merged at import)', show(k.duplicate_rate)],
      ['Records with source URLs', show(k.with_source_url_rate)],
      ['Researched companies with verified identity', show(k.verified_identity_rate)],
      ['Records with medium or high confidence', show(k.medium_or_high_confidence_rate)],
      ['Reviewed messages rejected or needing changes', show(k.substantial_correction_rate)],
    ]),
    '',
    '## Not tracked here',
    '',
    'This system stops at approved drafts. Record these in your CRM or sales sheet: outreach sent, responses, meetings booked, demonstrations completed, pilot opportunities, paying customers.',
    '',
  ].join('\n');
}
