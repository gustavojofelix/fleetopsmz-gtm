import { evaluateDraftCapabilities } from '../../domain/capability-gate.js';
import { comparisonKey } from '../../domain/normalize.js';
import type { CapabilityRegistry } from '../../schemas/capability.js';
import type { DraftType, OutreachChannel } from '../../schemas/outreach.js';
import type { CopywriterModelOutput, ModelDraft } from './model-output.js';
import type { DraftTarget } from './targets.js';

/** Maximum body length per channel, in characters. */
export const BODY_LIMITS: Record<OutreachChannel, number> = {
  email: 1_200,
  linkedin: 600,
  whatsapp: 500,
};
const SUBJECT_LIMIT = 90;

/** Words that mark a sentence as describing the product. */
const PRODUCT_TERMS = [
  'fleetops', 'plataforma', 'platform', 'solucao', 'solution', 'software', 'sistema', 'system',
  'ferramenta', 'tool', 'aplicacao', 'app', 'produto', 'product',
];

function words(text: string): string {
  return ` ${comparisonKey(text)} `;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

export interface CapabilityMention {
  key: string;
  keyword: string;
  /** True when the sentence also names the product, so it reads as a claim. */
  in_product_sentence: boolean;
}

/** Finds capability keywords in a text, sentence by sentence. */
export function findCapabilityMentions(text: string, registry: CapabilityRegistry): CapabilityMention[] {
  const mentions: CapabilityMention[] = [];
  for (const sentence of splitSentences(text)) {
    const sentenceWords = words(sentence);
    const aboutProduct = PRODUCT_TERMS.some((term) => sentenceWords.includes(` ${term} `));
    for (const capability of registry.capabilities) {
      const keyword = capability.keywords.find((k) => sentenceWords.includes(words(k)));
      if (keyword === undefined) continue;
      const existing = mentions.find((m) => m.key === capability.key);
      if (existing === undefined) {
        mentions.push({ key: capability.key, keyword, in_product_sentence: aboutProduct });
      } else if (aboutProduct) {
        existing.in_product_sentence = true;
      }
    }
  }
  return mentions;
}

export interface DraftCheck {
  target: DraftTarget;
  draft: ModelDraft | null;
  /** Reasons the draft cannot be used. Empty when it passed. */
  problems: string[];
  /** Points the human reviewer must check. They do not block the draft. */
  flags: string[];
  requires_capability_approval: boolean;
}

export interface CopyCheckContext {
  targets: readonly DraftTarget[];
  /** Short fact ids offered to the model (v1, v2, ...). */
  allowedFactIds: ReadonlySet<string>;
  registry: CapabilityRegistry;
  draftType: DraftType;
}

function checkDraft(target: DraftTarget, draft: ModelDraft, context: CopyCheckContext): DraftCheck {
  const problems: string[] = [];
  const flags: string[] = [];
  const text = [draft.subject ?? '', draft.body, draft.call_to_action].join('\n');

  // Shape.
  if (target.channel === 'email') {
    if (draft.subject === null) problems.push('an email needs a subject');
    else if (draft.subject.length > SUBJECT_LIMIT) {
      problems.push(`subject is longer than ${SUBJECT_LIMIT} characters`);
    }
  }
  const limit = BODY_LIMITS[target.channel];
  if (draft.body.length > limit) {
    problems.push(`body has ${draft.body.length} characters; the ${target.channel} limit is ${limit}`);
  }
  if (draft.opt_out_line.trim().length < 10) problems.push('opt_out_line is missing or too short');
  if (/\[[^\]]*\]|\{\{|\}\}|<[^>]+>|\bXXX\b/.test(text)) {
    problems.push('contains a placeholder; write the final text');
  }

  // Grounding.
  if (draft.fact_ids.length === 0) {
    problems.push('must use at least one verified fact about the company (fact_ids is empty)');
  }
  for (const id of draft.fact_ids) {
    if (!context.allowedFactIds.has(id)) problems.push(`fact "${id}" is not in <verified_facts>`);
  }
  if (text.includes('%')) problems.push('must not contain percentages or savings figures');
  if (/\b(MT|MZN|meticais|USD)\b|[$€]/i.test(text)) problems.push('must not mention prices');

  // Product capabilities.
  const gate = evaluateDraftCapabilities(context.registry, {
    draft_type: context.draftType,
    capability_refs: draft.capability_keys,
  });
  problems.push(...gate.violations);

  for (const mention of findCapabilityMentions(text, context.registry)) {
    const capability = context.registry.capabilities.find((c) => c.key === mention.key);
    if (capability === undefined) continue;
    const presentable =
      capability.status === 'implemented' || capability.status === 'partially_implemented';
    if (mention.in_product_sentence) {
      if (context.draftType === 'institutional_intro') {
        problems.push(
          `describes a product capability ("${mention.keyword}"); an institutional introduction must not`,
        );
      } else if (!presentable) {
        problems.push(
          `presents "${mention.keyword}" as a product capability, but "${mention.key}" is ${capability.status}`,
        );
      } else if (!draft.capability_keys.includes(mention.key)) {
        problems.push(`mentions capability "${mention.key}" without listing it in capability_keys`);
      }
    } else if (!presentable) {
      flags.push(
        `Mentions "${mention.keyword}" (capability "${mention.key}" is ${capability.status}): confirm it is not presented as a product feature.`,
      );
    }
  }
  for (const decision of gate.decisions) {
    if (decision.allowed && decision.requires_human_approval) {
      flags.push(
        `Uses partially implemented capability "${decision.key}". The message must state this limitation: ${decision.required_limitations ?? ''}`,
      );
    }
  }
  if (target.addressed_to === null) {
    flags.push('Addressed to a role, not a named person: no decision-maker was found publicly.');
  }

  return {
    target,
    draft,
    problems,
    flags,
    requires_capability_approval: gate.requires_capability_approval,
  };
}

/**
 * Checks every draft against its target. A draft with problems is not used;
 * flags are passed to the human reviewer.
 */
export function checkCopy(output: CopywriterModelOutput, context: CopyCheckContext): DraftCheck[] {
  return context.targets.map((target) => {
    const matching = output.drafts.filter((draft) => draft.target_id === target.target_id);
    const draft = matching[0];
    if (draft === undefined) {
      return {
        target,
        draft: null,
        problems: ['no draft was written for this target'],
        flags: [],
        requires_capability_approval: false,
      };
    }
    const check = checkDraft(target, draft, context);
    if (matching.length > 1) check.problems.push('more than one draft was written for this target');
    return check;
  });
}

/** Problems as one flat list, for the repair request. */
export function listProblems(checks: readonly DraftCheck[], output: CopywriterModelOutput): string[] {
  const known = new Set(checks.map((check) => check.target.target_id));
  return [
    ...checks.flatMap((check) => check.problems.map((problem) => `${check.target.target_id}: ${problem}`)),
    ...output.drafts
      .filter((draft) => !known.has(draft.target_id))
      .map((draft) => `${draft.target_id}: not a target in <targets>; remove it`),
  ];
}
