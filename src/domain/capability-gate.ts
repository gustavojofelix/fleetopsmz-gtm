import type { CapabilityRegistry, CapabilityStatus } from '../schemas/capability.js';
import type { DraftType } from '../schemas/outreach.js';

export type CapabilityDenyReason = 'unknown_capability' | 'status_not_presentable';

export interface CapabilityDecision {
  key: string;
  /** Null when the key is not in the registry. */
  status: CapabilityStatus | null;
  allowed: boolean;
  /** True for partially implemented capabilities. */
  requires_human_approval: boolean;
  /** Limitations text that must appear in the draft, when applicable. */
  required_limitations: string | null;
  reason: CapabilityDenyReason | null;
}

/**
 * Decides whether one capability may be mentioned in customer-facing text.
 *
 * - implemented: may be presented as available.
 * - partially_implemented: only with its limitations stated, and the draft is
 *   flagged for explicit human approval.
 * - planned, unverified, not_available, or unknown key: never.
 */
export function evaluateCapability(registry: CapabilityRegistry, key: string): CapabilityDecision {
  const entry = registry.capabilities.find((capability) => capability.key === key);
  if (entry === undefined) {
    return {
      key,
      status: null,
      allowed: false,
      requires_human_approval: false,
      required_limitations: null,
      reason: 'unknown_capability',
    };
  }
  if (entry.status === 'implemented') {
    return {
      key,
      status: entry.status,
      allowed: true,
      requires_human_approval: false,
      required_limitations: null,
      reason: null,
    };
  }
  if (entry.status === 'partially_implemented') {
    return {
      key,
      status: entry.status,
      allowed: true,
      requires_human_approval: true,
      required_limitations: entry.limitations,
      reason: null,
    };
  }
  return {
    key,
    status: entry.status,
    allowed: false,
    requires_human_approval: false,
    required_limitations: null,
    reason: 'status_not_presentable',
  };
}

/** Keys of capabilities that may be mentioned at all (with or without limitations). */
export function presentableCapabilityKeys(registry: CapabilityRegistry): string[] {
  return registry.capabilities
    .filter((c) => c.status === 'implemented' || c.status === 'partially_implemented')
    .map((c) => c.key);
}

/**
 * Commercial drafts are possible only once at least one capability is marked
 * implemented by a person. Until then Agent 3 writes institutional
 * introductions only. Agents 1 and 2 never depend on this.
 */
export function commercialDraftsEnabled(registry: CapabilityRegistry): boolean {
  return registry.capabilities.some((c) => c.status === 'implemented');
}

export interface DraftCapabilityCheck {
  allowed: boolean;
  requires_capability_approval: boolean;
  decisions: CapabilityDecision[];
  /** Human-readable reasons the draft was rejected. Empty when allowed. */
  violations: string[];
}

/**
 * Validates the capability references declared by a draft. Scanning the body
 * text for undeclared capability mentions is a separate check.
 */
export function evaluateDraftCapabilities(
  registry: CapabilityRegistry,
  draft: { draft_type: DraftType; capability_refs: readonly string[] },
): DraftCapabilityCheck {
  const decisions = draft.capability_refs.map((key) => evaluateCapability(registry, key));
  const violations: string[] = [];

  if (draft.draft_type === 'institutional_intro' && draft.capability_refs.length > 0) {
    violations.push('an institutional introduction must not reference product capabilities');
  }
  if (draft.draft_type === 'commercial') {
    if (draft.capability_refs.length === 0) {
      violations.push('a commercial draft must reference at least one capability');
    }
    if (!commercialDraftsEnabled(registry)) {
      violations.push('no capability is marked implemented: commercial drafts are disabled');
    }
  }
  for (const decision of decisions) {
    if (!decision.allowed) {
      violations.push(
        decision.reason === 'unknown_capability'
          ? `capability "${decision.key}" is not in the registry`
          : `capability "${decision.key}" has status "${decision.status}" and cannot be presented`,
      );
    }
  }

  return {
    allowed: violations.length === 0,
    requires_capability_approval: decisions.some((d) => d.allowed && d.requires_human_approval),
    decisions,
    violations,
  };
}
