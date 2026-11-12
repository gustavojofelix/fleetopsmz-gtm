import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideQualification } from '../../src/domain/qualification.js';
import {
  buildIcpAssessment,
  priorityForScore,
  scoreContacts,
  scoreGeography,
} from '../../src/domain/scoring.js';
import type { CriterionProposal } from '../../src/domain/scoring.js';
import { IcpAssessmentSchema } from '../../src/schemas/index.js';
import { loadTestConfig } from '../helpers.js';

const BANDS = { A: 80, B: 60, C: 40 };

function proposal(overrides: Partial<CriterionProposal> & Pick<CriterionProposal, 'key'>): CriterionProposal {
  return { points: 0, basis: 'inference', rationale: 'Reason.', fact_refs: [], ...overrides };
}

describe('priorityForScore', () => {
  const cases: [number, string][] = [
    [100, 'A'],
    [80, 'A'],
    [79, 'B'],
    [60, 'B'],
    [59, 'C'],
    [40, 'C'],
    [39, 'low'],
    [0, 'low'],
  ];
  for (const [score, expected] of cases) {
    it(`${score} is priority ${expected}`, () => {
      assert.equal(priorityForScore(score, BANDS), expected);
    });
  }
});

describe('buildIcpAssessment', () => {
  it('records every criterion, treating missing ones as unknown', async () => {
    const { scoring } = await loadTestConfig();
    const icp = buildIcpAssessment([proposal({ key: 'segment_relevance', points: 15 })], scoring);
    assert.equal(icp.criteria.length, 8);
    assert.equal(icp.score, 15);
    assert.equal(icp.coverage, 0.2);
    assert.equal(icp.priority, 'low');
    assert.equal(icp.criteria.filter((c) => c.basis === 'unknown').length, 7);
    assert.equal(IcpAssessmentSchema.safeParse(icp).success, true);
  });

  it('clamps points to the maximum and to zero, and rounds', async () => {
    const { scoring } = await loadTestConfig();
    const icp = buildIcpAssessment(
      [
        proposal({ key: 'segment_relevance', points: 99 }),
        proposal({ key: 'fleet_activity', points: -5 }),
        proposal({ key: 'operational_complexity', points: 7.6 }),
        proposal({ key: 'digital_maturity', points: Number.NaN }),
      ],
      scoring,
    );
    const points = Object.fromEntries(icp.criteria.map((c) => [c.key, c.points]));
    assert.equal(points['segment_relevance'], 20);
    assert.equal(points['fleet_activity'], 0);
    assert.equal(points['operational_complexity'], 8);
    assert.equal(points['digital_maturity'], 0);
    assert.equal(icp.score, 28);
  });

  it('gives unknown criteria zero points whatever was proposed', async () => {
    const { scoring } = await loadTestConfig();
    const icp = buildIcpAssessment(
      [proposal({ key: 'fleet_activity', points: 12, basis: 'unknown', fact_refs: ['fact_abc123'] })],
      scoring,
    );
    const fleet = icp.criteria.find((c) => c.key === 'fleet_activity');
    assert.equal(fleet?.points, 0);
    assert.deepEqual(fleet?.fact_refs, []);
  });

  it('downgrades evidence without a fact reference to inference', async () => {
    const { scoring } = await loadTestConfig();
    const icp = buildIcpAssessment(
      [
        proposal({ key: 'fleet_activity', points: 15, basis: 'evidence' }),
        proposal({ key: 'segment_relevance', points: 15, basis: 'evidence', fact_refs: ['fact_abc123'] }),
      ],
      scoring,
    );
    assert.equal(icp.criteria.find((c) => c.key === 'fleet_activity')?.basis, 'inference');
    assert.equal(icp.criteria.find((c) => c.key === 'segment_relevance')?.basis, 'evidence');
    assert.equal(IcpAssessmentSchema.safeParse(icp).success, true);
  });

  it('reports full coverage when every criterion is known', async () => {
    const { scoring } = await loadTestConfig();
    const icp = buildIcpAssessment(
      scoring.criteria.map((c) => proposal({ key: c.key, points: c.max })),
      scoring,
    );
    assert.equal(icp.score, 100);
    assert.equal(icp.coverage, 1);
    assert.equal(icp.priority, 'A');
  });
});

describe('scoreGeography', () => {
  it('scores Beira highest and follows the configured ranks', async () => {
    const { scoring } = await loadTestConfig();
    const at = (rank: number | null, listed = true) =>
      scoreGeography({ city: 'X', province: null, location_listed: listed, priority_rank: rank }, scoring).points;
    assert.equal(at(1), 15);
    assert.equal(at(2), 12);
    assert.equal(at(3), 10);
    assert.equal(at(4), 9);
    assert.equal(at(null), 7);
    assert.equal(at(null, false), 5);
  });

  it('is unknown, not zero-scored evidence, when no location was collected', async () => {
    const { scoring } = await loadTestConfig();
    const result = scoreGeography(
      { city: null, province: null, location_listed: false, priority_rank: null },
      scoring,
    );
    assert.equal(result.basis, 'unknown');
    assert.equal(result.points, 0);
  });
});

describe('scoreContacts', () => {
  it('counts distinct channel types', async () => {
    const { scoring } = await loadTestConfig();
    const none = scoreContacts({ phone: false, email: false, website: false }, scoring);
    assert.equal(none.basis, 'unknown');
    assert.equal(scoreContacts({ phone: true, email: false, website: false }, scoring).points, 3);
    assert.equal(scoreContacts({ phone: true, email: false, website: true }, scoring).points, 5);
    assert.equal(scoreContacts({ phone: true, email: true, website: true }, scoring).points, 5);
  });
});

describe('decideQualification', () => {
  it('qualifies A and B automatically', async () => {
    const { scoring } = await loadTestConfig();
    for (const priority of ['A', 'B'] as const) {
      assert.deepEqual(decideQualification({ coverage: 0.9, priority }, scoring, false), {
        qualification_status: 'qualified',
        review_reason: null,
      });
    }
  });

  it('holds C for manual promotion and archives low', async () => {
    const { scoring } = await loadTestConfig();
    assert.deepEqual(decideQualification({ coverage: 0.9, priority: 'C' }, scoring, false), {
      qualification_status: 'manual_review',
      review_reason: 'priority_c',
    });
    assert.deepEqual(decideQualification({ coverage: 0.9, priority: 'low' }, scoring, false), {
      qualification_status: 'low_priority',
      review_reason: null,
    });
  });

  it('sends incomplete information to review instead of rejecting it', async () => {
    const { scoring } = await loadTestConfig();
    for (const priority of ['A', 'low'] as const) {
      assert.deepEqual(decideQualification({ coverage: 0.49, priority }, scoring, false), {
        qualification_status: 'manual_review',
        review_reason: 'insufficient_information',
      });
    }
    assert.equal(
      decideQualification({ coverage: 0.5, priority: 'low' }, scoring, false).qualification_status,
      'low_priority',
    );
  });

  it('holds a possible duplicate before anything else', async () => {
    const { scoring } = await loadTestConfig();
    assert.deepEqual(decideQualification({ coverage: 1, priority: 'A' }, scoring, true), {
      qualification_status: 'manual_review',
      review_reason: 'possible_duplicate',
    });
  });
});
