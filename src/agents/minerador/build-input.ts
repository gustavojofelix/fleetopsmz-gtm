import type { LeadCandidate } from '../../schemas/candidate.js';
import type { ScoringConfig } from '../../schemas/settings.js';
import { MODEL_SCORED_CRITERIA } from './model-output.js';

/**
 * Builds the user message for one company. Only business fields are sent:
 * phone numbers and email addresses are not needed to classify a company, so
 * they never leave the machine at this stage.
 */
export function buildMineradorInput(candidate: LeadCandidate, scoring: ScoringConfig): string {
  const criteria = MODEL_SCORED_CRITERIA.map((key) => {
    const criterion = scoring.criteria.find((c) => c.key === key);
    return { key, label: criterion?.label ?? key, max_points: criterion?.max ?? 0 };
  });
  const company = {
    company_name: candidate.company_name,
    city: candidate.city,
    province: candidate.province,
    country: candidate.country,
    website: candidate.website,
    business_category: candidate.business_categories,
    business_description: candidate.business_descriptions,
  };
  return [
    'Assess the following company record.',
    '',
    '<company>',
    JSON.stringify(company, null, 2),
    '</company>',
    '',
    '<criteria>',
    JSON.stringify(criteria, null, 2),
    '</criteria>',
  ].join('\n');
}
