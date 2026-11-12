import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commercialDraftsEnabled,
  evaluateCapability,
  evaluateDraftCapabilities,
  presentableCapabilityKeys,
} from '../../src/domain/capability-gate.js';
import { CapabilityRegistrySchema } from '../../src/schemas/index.js';
import { capability, capabilityRegistry } from '../fixtures.js';

const VERIFIED = { verified_by: 'Reviewer', verified_at: '2026-11-12T16:40:00Z' };

const registry = CapabilityRegistrySchema.parse(
  capabilityRegistry([
    capability({ key: 'trips', status: 'implemented', ...VERIFIED }),
    capability({
      key: 'fuel',
      status: 'partially_implemented',
      limitations: 'Purchases only; no consumption analysis.',
      ...VERIFIED,
    }),
    capability({ key: 'reports', status: 'planned' }),
    capability({ key: 'dashboard', status: 'unverified' }),
    capability({ key: 'gps_telematics', status: 'not_available' }),
  ]),
);

const allUnverified = CapabilityRegistrySchema.parse(
  capabilityRegistry([capability({ key: 'trips' }), capability({ key: 'fuel' })]),
);

describe('evaluateCapability', () => {
  it('allows an implemented capability without extra approval', () => {
    const decision = evaluateCapability(registry, 'trips');
    assert.equal(decision.allowed, true);
    assert.equal(decision.requires_human_approval, false);
  });

  it('allows a partially implemented capability only with limitations and approval', () => {
    const decision = evaluateCapability(registry, 'fuel');
    assert.equal(decision.allowed, true);
    assert.equal(decision.requires_human_approval, true);
    assert.equal(decision.required_limitations, 'Purchases only; no consumption analysis.');
  });

  for (const key of ['reports', 'dashboard', 'gps_telematics']) {
    it(`never allows "${key}" (planned, unverified or not available)`, () => {
      const decision = evaluateCapability(registry, key);
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'status_not_presentable');
    });
  }

  it('rejects a capability that is not in the registry', () => {
    const decision = evaluateCapability(registry, 'route_optimization');
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unknown_capability');
  });
});

describe('commercialDraftsEnabled', () => {
  it('is false while every capability is unverified', () => {
    assert.equal(commercialDraftsEnabled(allUnverified), false);
    assert.deepEqual(presentableCapabilityKeys(allUnverified), []);
  });

  it('is true once one capability is implemented', () => {
    assert.equal(commercialDraftsEnabled(registry), true);
    assert.deepEqual(presentableCapabilityKeys(registry), ['trips', 'fuel']);
  });
});

describe('evaluateDraftCapabilities', () => {
  it('allows an institutional introduction even when nothing is verified', () => {
    const check = evaluateDraftCapabilities(allUnverified, {
      draft_type: 'institutional_intro',
      capability_refs: [],
    });
    assert.equal(check.allowed, true);
    assert.equal(check.requires_capability_approval, false);
  });

  it('rejects an institutional introduction that references a capability', () => {
    const check = evaluateDraftCapabilities(registry, {
      draft_type: 'institutional_intro',
      capability_refs: ['trips'],
    });
    assert.equal(check.allowed, false);
  });

  it('rejects any commercial draft while nothing is implemented', () => {
    const check = evaluateDraftCapabilities(allUnverified, {
      draft_type: 'commercial',
      capability_refs: ['trips'],
    });
    assert.equal(check.allowed, false);
    assert.equal(check.violations.length, 2);
  });

  it('allows a commercial draft that references only implemented capabilities', () => {
    const check = evaluateDraftCapabilities(registry, {
      draft_type: 'commercial',
      capability_refs: ['trips'],
    });
    assert.equal(check.allowed, true);
    assert.equal(check.requires_capability_approval, false);
  });

  it('flags a commercial draft for approval when it uses a partial capability', () => {
    const check = evaluateDraftCapabilities(registry, {
      draft_type: 'commercial',
      capability_refs: ['trips', 'fuel'],
    });
    assert.equal(check.allowed, true);
    assert.equal(check.requires_capability_approval, true);
  });

  it('rejects a commercial draft when any one reference fails the gate', () => {
    const check = evaluateDraftCapabilities(registry, {
      draft_type: 'commercial',
      capability_refs: ['trips', 'gps_telematics'],
    });
    assert.equal(check.allowed, false);
    assert.match(check.violations.join(' '), /gps_telematics/);
  });
});
