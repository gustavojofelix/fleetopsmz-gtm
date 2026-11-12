import type {
  IcpAssessment,
  IcpCriterionKey,
  IcpCriterionScore,
  ScoreBasis,
} from '../schemas/lead.js';
import type { Priority } from '../schemas/primitives.js';
import type { ScoringConfig } from '../schemas/settings.js';

/** A proposed score for one criterion, before clamping and validation. */
export interface CriterionProposal {
  key: IcpCriterionKey;
  points: number;
  basis: ScoreBasis;
  rationale: string;
  fact_refs: readonly string[];
}

export function priorityForScore(score: number, bands: ScoringConfig['bands']): Priority {
  if (score >= bands.A) return 'A';
  if (score >= bands.B) return 'B';
  if (score >= bands.C) return 'C';
  return 'low';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Turns proposals into the final assessment. Arithmetic is done here, never by
 * the model:
 * - points are rounded and clamped to the criterion maximum;
 * - an unknown criterion carries 0 points (uncertainty shows up in coverage);
 * - "evidence" without a fact reference is downgraded to "inference";
 * - a criterion with no proposal is recorded as unknown.
 * Coverage is the share of available points whose basis is not unknown.
 */
export function buildIcpAssessment(
  proposals: readonly CriterionProposal[],
  config: ScoringConfig,
): IcpAssessment {
  const criteria: IcpCriterionScore[] = config.criteria.map((criterion) => {
    const proposal = proposals.find((p) => p.key === criterion.key);
    if (proposal === undefined) {
      return {
        key: criterion.key,
        points: 0,
        max: criterion.max,
        basis: 'unknown',
        rationale: 'Not assessed: no information available.',
        fact_refs: [],
      };
    }
    const factRefs = [...new Set(proposal.fact_refs)];
    let basis: ScoreBasis = proposal.basis;
    if (basis === 'evidence' && factRefs.length === 0) basis = 'inference';
    const points =
      basis === 'unknown' || !Number.isFinite(proposal.points)
        ? 0
        : clamp(Math.round(proposal.points), 0, criterion.max);
    return {
      key: criterion.key,
      points,
      max: criterion.max,
      basis,
      rationale: proposal.rationale,
      fact_refs: basis === 'unknown' ? [] : factRefs,
    };
  });

  const total = criteria.reduce((sum, c) => sum + c.max, 0);
  const known = criteria.filter((c) => c.basis !== 'unknown').reduce((sum, c) => sum + c.max, 0);
  const score = criteria.reduce((sum, c) => sum + c.points, 0);
  return {
    criteria,
    score,
    coverage: total === 0 ? 0 : Math.round((known / total) * 100) / 100,
    priority: priorityForScore(score, config.bands),
  };
}

export interface LocationForScoring {
  city: string | null;
  province: string | null;
  location_listed: boolean;
  priority_rank: number | null;
}

/** Geographic relevance comes from config/geography.json, not from the model. */
export function scoreGeography(
  location: LocationForScoring,
  config: ScoringConfig,
): CriterionProposal {
  const key = 'geographic_relevance' as const;
  const table = config.geographic_points;
  if (location.city === null && location.province === null) {
    return { key, points: 0, basis: 'unknown', rationale: 'No location was collected.', fact_refs: [] };
  }
  const place = location.city ?? location.province ?? '';
  if (location.location_listed && location.priority_rank !== null) {
    const points = table.by_priority_rank[String(location.priority_rank)] ?? table.listed_city;
    return {
      key,
      points,
      basis: 'inference',
      rationale: `Listed in ${place}, commercial priority region ${location.priority_rank}.`,
      fact_refs: [],
    };
  }
  if (location.location_listed) {
    return {
      key,
      points: table.listed_city,
      basis: 'inference',
      rationale: `Listed in ${place}, a known hub outside the priority regions.`,
      fact_refs: [],
    };
  }
  return {
    key,
    points: table.unlisted_location,
    basis: 'inference',
    rationale: `Listed in ${place}, which is not in the geography configuration.`,
    fact_refs: [],
  };
}

/** Contact availability counts the distinct public channel types collected. */
export function scoreContacts(
  channels: { phone: boolean; email: boolean; website: boolean },
  config: ScoringConfig,
): CriterionProposal {
  const key = 'contact_availability' as const;
  const available = (['phone', 'email', 'website'] as const).filter((c) => channels[c]);
  if (available.length === 0) {
    return {
      key,
      points: 0,
      basis: 'unknown',
      rationale: 'No public business contact was collected.',
      fact_refs: [],
    };
  }
  return {
    key,
    points:
      available.length === 1
        ? config.contact_points.one_channel
        : config.contact_points.two_or_more_channels,
    basis: 'inference',
    rationale: `Collected channels: ${available.join(', ')}.`,
    fact_refs: [],
  };
}
