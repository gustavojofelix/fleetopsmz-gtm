import type { ResearchDossier } from '../schemas/dossier.js';
import type { PromotionRecord, QualifiedLead } from '../schemas/lead.js';
import type { Fact } from '../schemas/primitives.js';

export interface ResearchSelection {
  selected: QualifiedLead[];
  held: { lead: QualifiedLead; reason: string }[];
}

/**
 * Decides which leads go to Agent 2. Qualified leads (priority A and B)
 * proceed automatically. Leads held for review or archived proceed only when
 * a person promoted them. A person can also archive a qualified lead.
 */
export function selectForResearch(
  leads: readonly QualifiedLead[],
  promotions: ReadonlyMap<string, PromotionRecord>,
): ResearchSelection {
  const selected: QualifiedLead[] = [];
  const held: ResearchSelection['held'] = [];
  for (const lead of leads) {
    const decision = promotions.get(lead.lead_id)?.decision;
    if (decision === 'archive') {
      held.push({ lead, reason: 'archived by a reviewer' });
    } else if (decision === 'promote') {
      selected.push(lead);
    } else if (lead.qualification_status === 'qualified') {
      selected.push(lead);
    } else if (lead.qualification_status === 'manual_review') {
      held.push({ lead, reason: `held for manual review (${lead.review_reason ?? 'other'})` });
    } else {
      held.push({ lead, reason: `not qualified (${lead.qualification_status})` });
    }
  }
  return { selected, held };
}

/**
 * Facts a message may rely on: verified, with high or medium confidence.
 * Low-confidence facts and hypotheses are never presented as confirmed.
 */
export function usableFacts(dossier: ResearchDossier): Fact[] {
  const seen = new Set<string>();
  return [...dossier.identity_evidence, ...dossier.facts].filter((fact) => {
    if (fact.kind !== 'verified' || fact.confidence === 'low' || seen.has(fact.fact_id)) return false;
    seen.add(fact.fact_id);
    return true;
  });
}

export interface OutreachGate {
  allowed: boolean;
  reasons: string[];
}

/** Decides whether a dossier is solid enough for Agent 3 to draft outreach. */
export function canDraftOutreach(dossier: ResearchDossier): OutreachGate {
  const reasons: string[] = [];
  if (!dossier.identity_verified) reasons.push('company identity is not verified');
  if (usableFacts(dossier).length === 0) {
    reasons.push('no verified fact with high or medium confidence');
  }
  if (!dossier.lead.public_contacts.some((contact) => contact.scope === 'corporate')) {
    reasons.push('no public corporate contact channel');
  }
  return { allowed: reasons.length === 0, reasons };
}
