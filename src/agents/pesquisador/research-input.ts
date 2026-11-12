import type { QualifiedLead } from '../../schemas/lead.js';
import type { SearchResult } from '../../schemas/search.js';
import type { ScoringConfig } from '../../schemas/settings.js';
import { MODEL_SCORED_CRITERIA } from '../minerador/model-output.js';

export const RESULTS_PER_QUERY = 8;
export const MAX_RESULTS_PER_LEAD = 24;
export const SEARCH_COUNTRY = 'mz';

/**
 * The searches run for one company. Four queries per lead: identity,
 * activity, contact channels and leadership. Each query costs one search credit.
 */
export function buildResearchQueries(lead: QualifiedLead): string[] {
  const name = `"${lead.company_name.replace(/"/g, '')}"`;
  const place = lead.city ?? lead.country;
  return [
    `${name} ${place}`,
    `${name} transporte logística frota camiões`,
    `${name} contacto telefone email`,
    `${name} director geral gerente`,
  ];
}

export interface NumberedResult extends SearchResult {
  /** Short reference the model uses to cite this result: r1, r2, ... */
  id: string;
}

/** Merges the result lists, drops repeated URLs and numbers what is left. */
export function numberResults(
  batches: readonly (readonly SearchResult[])[],
  max = MAX_RESULTS_PER_LEAD,
): NumberedResult[] {
  const seen = new Set<string>();
  const numbered: NumberedResult[] = [];
  for (const batch of batches) {
    for (const result of batch) {
      const key = result.url.replace(/\/+$/, '').toLowerCase();
      if (seen.has(key) || numbered.length >= max) continue;
      seen.add(key);
      numbered.push({ ...result, id: `r${numbered.length + 1}` });
    }
  }
  return numbered;
}

/** Builds the user message: what is already known, the search results, the criteria. */
export function buildPesquisadorInput(
  lead: QualifiedLead,
  results: readonly NumberedResult[],
  scoring: ScoringConfig,
): string {
  const company = {
    company_name: lead.company_name,
    city: lead.city,
    province: lead.province,
    country: lead.country,
    business_segment: lead.business_segment,
    known_website: lead.website,
    collected_description: lead.business_description,
  };
  const criteria = MODEL_SCORED_CRITERIA.map((key) => {
    const criterion = scoring.criteria.find((c) => c.key === key);
    return { key, label: criterion?.label ?? key, max_points: criterion?.max ?? 0 };
  });
  return [
    'Research the following company using only the search results provided.',
    '',
    '<company>',
    JSON.stringify(company, null, 2),
    '</company>',
    '',
    '<search_results>',
    JSON.stringify(
      results.map((r) => ({ id: r.id, url: r.url, title: r.title, snippet: r.snippet })),
      null,
      2,
    ),
    '</search_results>',
    '',
    '<criteria>',
    JSON.stringify(criteria, null, 2),
    '</criteria>',
  ].join('\n');
}
