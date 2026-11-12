import type { QualifiedLead } from '../schemas/lead.js';
import type { RejectedRawRow } from '../schemas/raw.js';

export interface QualificationSummaryInput {
  run_id: string;
  generated_at: string;
  model: string;
  prompt_version: string;
  input_files: { path: string; sha256: string; rows: number }[];
  valid_rows: number;
  merged_rows: number;
  candidates: number;
  not_processed: number;
  cache_hits: number;
  usage: { input_tokens: number; output_tokens: number };
  leads: readonly QualifiedLead[];
  failures: readonly { lead_id: string; company_name: string; code: string; message: string }[];
  rejected: readonly RejectedRawRow[];
}

export interface QualificationCounts {
  leads: number;
  qualified: number;
  manual_review: number;
  low_priority: number;
  priority: { A: number; B: number; C: number; low: number };
  with_source_url: number;
  medium_or_high_confidence: number;
}

export function countLeads(leads: readonly QualifiedLead[]): QualificationCounts {
  const count = (predicate: (lead: QualifiedLead) => boolean): number =>
    leads.filter(predicate).length;
  return {
    leads: leads.length,
    qualified: count((l) => l.qualification_status === 'qualified'),
    manual_review: count((l) => l.qualification_status === 'manual_review'),
    low_priority: count((l) => l.qualification_status === 'low_priority'),
    priority: {
      A: count((l) => l.icp.priority === 'A'),
      B: count((l) => l.icp.priority === 'B'),
      C: count((l) => l.icp.priority === 'C'),
      low: count((l) => l.icp.priority === 'low'),
    },
    with_source_url: count((l) => l.source_urls.length > 0),
    medium_or_high_confidence: count((l) => l.confidence !== 'low'),
  };
}

function cell(value: string | number | null): string {
  if (value === null) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
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

/** Builds qualification_summary.md for one Agent 1 run. */
export function renderQualificationSummary(input: QualificationSummaryInput): string {
  const counts = countLeads(input.leads);
  const ranked = [...input.leads].sort((a, b) => b.icp.score - a.icp.score);
  const held = ranked.filter((lead) => lead.qualification_status === 'manual_review');
  const sections: string[] = [];

  sections.push(
    `# Qualification summary`,
    '',
    `- Run: \`${input.run_id}\``,
    `- Generated: ${input.generated_at}`,
    `- Model: ${input.model}`,
    `- Prompt version: ${input.prompt_version}`,
    '',
    'Scores indicate potential commercial fit from collected data only. They are not purchase intent, and nothing here has been verified by research yet.',
    '',
    '## Input',
    '',
    table(
      ['File', 'Rows', 'SHA-256'],
      input.input_files.map((file) => [file.path, file.rows, file.sha256.slice(0, 12)]),
    ),
    '',
    '## Results',
    '',
    table(
      ['Measure', 'Count'],
      [
        ['Valid rows imported', input.valid_rows],
        ['Rows rejected at import', input.rejected.length],
        ['Rows merged as duplicates', input.merged_rows],
        ['Companies identified', input.candidates],
        ['Companies assessed', counts.leads],
        ['Qualified (proceed to research)', counts.qualified],
        ['Held for manual review', counts.manual_review],
        ['Low priority (archived)', counts.low_priority],
        ['Failed', input.failures.length],
        ['Not processed (batch limit)', input.not_processed],
      ],
    ),
    '',
    table(
      ['Priority', 'Count'],
      [
        ['A (80 to 100)', counts.priority.A],
        ['B (60 to 79)', counts.priority.B],
        ['C (40 to 59)', counts.priority.C],
        ['Low (below 40)', counts.priority.low],
      ],
    ),
    '',
    '## Quality',
    '',
    table(
      ['Indicator', 'Value'],
      [
        ['Duplicate rate (merged rows / valid rows)', percent(input.merged_rows, input.valid_rows)],
        ['Leads with at least one source URL', percent(counts.with_source_url, counts.leads)],
        [
          'Leads with medium or high confidence',
          percent(counts.medium_or_high_confidence, counts.leads),
        ],
      ],
    ),
    '',
    '## Leads',
    '',
  );

  if (ranked.length === 0) {
    sections.push('No leads were assessed in this run.', '');
  } else {
    sections.push(
      table(
        ['Company', 'City', 'Segment', 'Score', 'Coverage', 'Priority', 'Status', 'Lead ID'],
        ranked.map((lead) => [
          lead.company_name,
          lead.city,
          lead.business_segment,
          lead.icp.score,
          `${Math.round(lead.icp.coverage * 100)}%`,
          lead.icp.priority,
          lead.qualification_status,
          `\`${lead.lead_id}\``,
        ]),
      ),
      '',
    );
  }

  if (held.length > 0) {
    sections.push(
      '## Held for manual review',
      '',
      'To promote or archive one of these, add a row to `data/reviews/promotions.csv`.',
      '',
      table(
        ['Company', 'Reason', 'Score', 'Lead ID'],
        held.map((lead) => [
          lead.company_name,
          lead.review_reason,
          lead.icp.score,
          `\`${lead.lead_id}\``,
        ]),
      ),
      '',
    );
  }

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

  if (input.rejected.length > 0) {
    sections.push(
      '## Rejected rows',
      '',
      table(
        ['File', 'Row', 'Reason'],
        input.rejected.map((row) => [row.source_file, row.row_number, row.reason]),
      ),
      '',
    );
  }

  sections.push(
    '## Model usage',
    '',
    table(
      ['Measure', 'Value'],
      [
        ['Assessments reused from cache', input.cache_hits],
        ['Input tokens', input.usage.input_tokens],
        ['Output tokens', input.usage.output_tokens],
      ],
    ),
    '',
  );

  return sections.join('\n');
}
