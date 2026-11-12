import { PERSONA_LABELS } from '../agents/copywriter/targets.js';
import type { ResearchDossier } from '../schemas/dossier.js';
import type { OutreachDraft, OutreachPackage } from '../schemas/outreach.js';
import type { OutreachConfig } from '../schemas/settings.js';
import { stringifyCsv } from '../tools/csv.js';
import type { CsvValue } from '../tools/csv.js';

type Sender = OutreachConfig['sender'];

/** Signature added to a draft. Email carries full details; chat channels a short one. */
export function signatureFor(draft: Pick<OutreachDraft, 'channel'>, sender: Sender): string {
  const identity = [sender.name, [sender.role, sender.company].filter((part) => part !== null).join(', ')]
    .filter((part) => part !== null && part !== '')
    .join('\n');
  if (draft.channel !== 'email') return identity;
  const details = [sender.email, sender.phone, sender.website].filter((part) => part !== null).join(' | ');
  return details === '' ? identity : `${identity}\n${details}`;
}

/** The message exactly as it would be sent: body, signature, opt-out line. */
export function fullMessage(draft: OutreachDraft, sender: Sender): string {
  return [draft.body, signatureFor(draft, sender), draft.opt_out_line].join('\n\n');
}

function contactValue(dossier: ResearchDossier, contactId: string | null): string | null {
  if (contactId === null) return null;
  return dossier.lead.public_contacts.find((c) => c.contact_id === contactId)?.value ?? null;
}

export const OUTREACH_CSV_COLUMNS: readonly string[] = [
  'draft_id',
  'lead_id',
  'company_name',
  'city',
  'channel',
  'send_to',
  'recipient_name',
  'recipient_role',
  'draft_type',
  'language',
  'subject',
  'message',
  'call_to_action',
  'requires_capability_approval',
  'review_flags',
  'approval_status',
  'run_id',
];

export interface OutreachEntry {
  dossier: ResearchDossier;
  pkg: OutreachPackage;
}

function csvRow(entry: OutreachEntry, draft: OutreachDraft, sender: Sender, status: string): CsvValue[] {
  const lead = entry.dossier.lead;
  return [
    draft.draft_id,
    lead.lead_id,
    lead.company_name,
    lead.city,
    draft.channel,
    contactValue(entry.dossier, draft.contact_id),
    draft.addressed_to,
    PERSONA_LABELS[draft.persona][draft.language],
    draft.draft_type,
    draft.language,
    draft.subject,
    fullMessage(draft, sender),
    draft.call_to_action,
    draft.requires_capability_approval,
    draft.review_flags.join(' / '),
    status,
    entry.pkg.provenance.run_id,
  ];
}

/** One row per draft. Every draft is pending human review. */
export function outreachToCsv(entries: readonly OutreachEntry[], sender: Sender): string {
  return stringifyCsv([
    OUTREACH_CSV_COLUMNS,
    ...entries.flatMap((entry) =>
      entry.pkg.drafts.map((draft) => csvRow(entry, draft, sender, 'pending_human_review')),
    ),
  ]);
}

/** Only drafts a person approved, ready to be sent manually. */
export function approvedToCsv(
  approved: readonly { entry: OutreachEntry; draft: OutreachDraft; reviewer: string; decided_at: string }[],
  sender: Sender,
): string {
  return stringifyCsv([
    [...OUTREACH_CSV_COLUMNS, 'approved_by', 'approved_at'],
    ...approved.map((item) => [
      ...csvRow(item.entry, item.draft, sender, 'approved'),
      item.reviewer,
      item.decided_at,
    ]),
  ]);
}

/** The message set for one company, as a document the reviewer reads and approves from. */
export function renderOutreachMarkdown(entry: OutreachEntry, sender: Sender): string {
  const lead = entry.dossier.lead;
  const sections: string[] = [
    `# Outreach drafts: ${lead.company_name}`,
    '',
    `- Lead ID: \`${lead.lead_id}\``,
    `- Status: **pending human review**. Nothing has been sent.`,
    `- To approve a draft, add a row to \`data/reviews/approvals.csv\` with its draft ID.`,
    '',
  ];
  entry.pkg.drafts.forEach((draft, index) => {
    const recipient = draft.addressed_to ?? `${PERSONA_LABELS[draft.persona][draft.language]} (no name found)`;
    sections.push(
      `## Draft ${index + 1}: ${draft.channel}, ${recipient}`,
      '',
      `- Draft ID: \`${draft.draft_id}\``,
      `- Type: ${draft.draft_type}`,
      `- Send to: ${contactValue(entry.dossier, draft.contact_id) ?? 'no public contact found for this channel'}`,
      ...(draft.subject === null ? [] : [`- Subject: ${draft.subject}`]),
      `- Facts used: ${draft.fact_refs.map((id) => `\`${id}\``).join(', ')}`,
      ...(draft.capability_refs.length === 0
        ? []
        : [`- Capabilities mentioned: ${draft.capability_refs.join(', ')}`]),
      ...(draft.requires_capability_approval
        ? ['- **Needs explicit approval: mentions a partially implemented capability.**']
        : []),
      '',
      ...(draft.review_flags.length === 0
        ? []
        : ['Check before approving:', '', ...draft.review_flags.map((flag) => `- ${flag}`), '']),
      '```text',
      fullMessage(draft, sender),
      '```',
      '',
    );
  });
  return sections.join('\n');
}
