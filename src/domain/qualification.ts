import type { IcpAssessment, QualificationStatus, ReviewReason } from '../schemas/lead.js';
import type { ScoringConfig } from '../schemas/settings.js';

export interface QualificationDecision {
  qualification_status: QualificationStatus;
  review_reason: ReviewReason | null;
}

/**
 * Decides what happens to a scored lead. Checked in this order:
 * 1. a possible duplicate is held for a person to merge or separate;
 * 2. too little information is held for review, never rejected;
 * 3. priorities configured for automatic research (A and B) are qualified;
 * 4. priority C is held for manual promotion;
 * 5. anything lower is archived as low priority.
 */
export function decideQualification(
  icp: Pick<IcpAssessment, 'coverage' | 'priority'>,
  config: ScoringConfig,
  possibleDuplicate: boolean,
): QualificationDecision {
  if (possibleDuplicate) {
    return { qualification_status: 'manual_review', review_reason: 'possible_duplicate' };
  }
  if (icp.coverage < config.coverage_threshold) {
    return { qualification_status: 'manual_review', review_reason: 'insufficient_information' };
  }
  if (config.auto_research_priorities.includes(icp.priority)) {
    return { qualification_status: 'qualified', review_reason: null };
  }
  if (icp.priority === 'low') {
    return { qualification_status: 'low_priority', review_reason: null };
  }
  return { qualification_status: 'manual_review', review_reason: 'priority_c' };
}
