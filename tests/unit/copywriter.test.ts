import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunContext } from '../../src/agents/agent.js';
import {
  NEUTRAL_PRODUCT_DESCRIPTION,
  buildCopywriterInput,
  createCopywriterAgent,
} from '../../src/agents/copywriter/copywriter.js';
import { CopywriterModelOutputSchema } from '../../src/agents/copywriter/model-output.js';
import type { ModelDraft } from '../../src/agents/copywriter/model-output.js';
import { buildTargets } from '../../src/agents/copywriter/targets.js';
import { BODY_LIMITS, checkCopy, findCapabilityMentions } from '../../src/agents/copywriter/validate.js';
import type { ProjectConfig } from '../../src/config/project-config.js';
import { senderProblems } from '../../src/config/project-config.js';
import {
  approvedToCsv,
  fullMessage,
  outreachToCsv,
  renderOutreachMarkdown,
  signatureFor,
} from '../../src/reporting/outreach-export.js';
import { renderDossierMarkdown } from '../../src/reporting/dossier-markdown.js';
import { OutreachPackageSchema } from '../../src/schemas/index.js';
import type { CapabilityRegistry, OutreachPackage, ResearchDossier } from '../../src/schemas/index.js';
import { parseCsv } from '../../src/tools/csv.js';
import {
  NEUTRAL_BODY,
  TEST_MODEL,
  TEST_PROMPT,
  TEST_RUN_ID,
  copyReply,
  createScriptedLlm,
  fixedClock,
  loadConfigWithSender,
  loadConfigWithoutSender,
  loadTestConfig,
  makeDossier,
  noSleepRetry,
  registryWith,
  researchReading,
  silentLogger,
  targetsIn,
} from '../helpers.js';
import type { ScriptedReply } from '../helpers.js';

const CONTEXT: RunContext = { runId: TEST_RUN_ID, model: TEST_MODEL, logger: silentLogger, clock: fixedClock };

function modelDraft(overrides: Partial<ModelDraft> = {}): ModelDraft {
  return {
    target_id: 't1',
    subject: 'Apresentação do FleetOps MZ',
    body: NEUTRAL_BODY,
    call_to_action: 'Marcar uma conversa breve.',
    opt_out_line: 'Se preferir não receber mais contactos, basta responder a esta mensagem.',
    fact_ids: ['v1'],
    capability_keys: [],
    ...overrides,
  };
}

async function checkOne(
  draft: ModelDraft,
  options: { registry?: CapabilityRegistry; draftType?: 'institutional_intro' | 'commercial' } = {},
) {
  const config = await loadConfigWithSender();
  const dossier = await makeDossier();
  const targets = buildTargets(dossier, config.outreach).slice(0, 1);
  const [check] = checkCopy(
    { drafts: [draft] },
    {
      targets,
      allowedFactIds: new Set(['v1', 'v2', 'v3']),
      registry: options.registry ?? config.capabilities,
      draftType: options.draftType ?? 'institutional_intro',
    },
  );
  assert.ok(check);
  return check;
}

describe('buildTargets', () => {
  it('addresses the named decision-maker and falls back to roles for the rest', async () => {
    const config = await loadConfigWithSender();
    const targets = buildTargets(await makeDossier(), config.outreach);
    assert.deepEqual(
      targets.map((t) => [t.target_id, t.channel, t.persona, t.addressed_to]),
      [
        ['t1', 'email', 'managing_director', 'João Exemplo'],
        ['t2', 'linkedin', 'managing_director', 'João Exemplo'],
        ['t3', 'email', 'operations_director', null],
        ['t4', 'email', 'fleet_manager', null],
        ['t5', 'whatsapp', 'managing_director', null],
      ],
    );
    assert.equal(targets[0]?.role_title, 'Director Geral');
    assert.equal(targets.every((t) => t.channel === 'linkedin' || t.contact_id !== null), true);
  });

  it('never names a person when research found none', async () => {
    const config = await loadConfigWithSender();
    const reading = researchReading();
    reading.contacts = [];
    const targets = buildTargets(await makeDossier(reading), config.outreach);
    assert.equal(targets.every((t) => t.addressed_to === null), true);
    assert.deepEqual(targets.map((t) => t.channel), ['email', 'email', 'email', 'whatsapp', 'linkedin']);
    assert.equal(targets.find((t) => t.channel === 'linkedin')?.contact_id, null);
  });

  it('writes no email draft when no public email exists', async () => {
    const config = await loadConfigWithSender();
    const dossier = await makeDossier();
    const phoneOnly: ResearchDossier = {
      ...dossier,
      lead: { ...dossier.lead, public_contacts: dossier.lead.public_contacts.filter((c) => c.channel === 'phone') },
    };
    assert.deepEqual(buildTargets(phoneOnly, config.outreach).map((t) => t.channel), ['whatsapp', 'linkedin']);
  });

  it('respects the configured persona and draft limits', async () => {
    const config = await loadConfigWithSender();
    const dossier = await makeDossier();
    const one = buildTargets(dossier, { ...config.outreach, max_personas: 1 });
    assert.deepEqual([...new Set(one.map((t) => t.persona))], ['managing_director']);
    assert.equal(buildTargets(dossier, { ...config.outreach, max_drafts_per_lead: 2 }).length, 2);
  });
});

describe('findCapabilityMentions', () => {
  it('tells a product claim from a mention of the prospect’s own operations', async () => {
    const { capabilities } = await loadTestConfig();
    const text =
      'Muitas empresas têm dificuldade em acompanhar o combustível de cada viatura. A nossa plataforma organiza as viagens da frota.';
    const mentions = findCapabilityMentions(text, capabilities);
    assert.deepEqual(
      mentions.map((m) => [m.key, m.in_product_sentence]).sort(),
      [
        ['fuel', false],
        ['trips', true],
      ],
    );
  });

  it('matches whole words only and ignores accents and case', async () => {
    const { capabilities } = await loadTestConfig();
    assert.deepEqual(findCapabilityMentions('Os viajantes chegaram.', capabilities), []);
    assert.equal(findCapabilityMentions('MANUTENCAO preventiva', capabilities)[0]?.key, 'maintenance');
    assert.equal(findCapabilityMentions('rastreamento por gps', capabilities)[0]?.key, 'gps_telematics');
  });
});

describe('draft checks', () => {
  it('accepts a neutral institutional introduction', async () => {
    const check = await checkOne(modelDraft());
    assert.deepEqual(check.problems, []);
    assert.equal(check.requires_capability_approval, false);
  });

  it('rejects an institutional introduction that describes what the product does', async () => {
    const check = await checkOne(
      modelDraft({ body: `${NEUTRAL_BODY} A plataforma permite controlar o combustível e as viagens.` }),
    );
    assert.equal(check.problems.some((p) => /institutional introduction must not/.test(p)), true);
  });

  it('flags, but allows, a question about the prospect’s operations', async () => {
    const check = await checkOne(
      modelDraft({ body: `${NEUTRAL_BODY} Como acompanham hoje as viagens e o combustível?` }),
    );
    assert.deepEqual(check.problems, []);
    assert.equal(check.flags.filter((f) => /confirm it is not presented as a product feature/.test(f)).length, 2);
  });

  it('rejects capability keys in an institutional introduction', async () => {
    const check = await checkOne(modelDraft({ capability_keys: ['trips'] }));
    assert.equal(check.problems.length > 0, true);
  });

  it('rejects percentages, prices and placeholders', async () => {
    assert.match((await checkOne(modelDraft({ body: `${NEUTRAL_BODY} Reduza custos em 20%.` }))).problems.join(' '), /percentages/);
    assert.match((await checkOne(modelDraft({ body: `${NEUTRAL_BODY} A partir de 3.000 MT.` }))).problems.join(' '), /prices/);
    assert.match((await checkOne(modelDraft({ body: 'Bom dia [Nome]. Gostaria de conversar.' }))).problems.join(' '), /placeholder/);
  });

  it('rejects drafts without facts or citing facts that were not offered', async () => {
    assert.match((await checkOne(modelDraft({ fact_ids: [] }))).problems.join(' '), /at least one verified fact/);
    assert.match((await checkOne(modelDraft({ fact_ids: ['v9'] }))).problems.join(' '), /"v9" is not in/);
  });

  it('enforces the subject, the length limit and the opt-out line', async () => {
    assert.match((await checkOne(modelDraft({ subject: null }))).problems.join(' '), /needs a subject/);
    assert.match((await checkOne(modelDraft({ subject: 'x'.repeat(91) }))).problems.join(' '), /subject is longer/);
    const long = await checkOne(modelDraft({ body: 'a'.repeat(BODY_LIMITS.email + 1) }));
    assert.match(long.problems.join(' '), /email limit is 1200/);
    assert.match((await checkOne(modelDraft({ opt_out_line: 'ok' }))).problems.join(' '), /opt_out_line/);
  });

  it('reports a missing or duplicated draft for a target', async () => {
    const config = await loadConfigWithSender();
    const targets = buildTargets(await makeDossier(), config.outreach).slice(0, 2);
    const context = { targets, allowedFactIds: new Set(['v1']), registry: config.capabilities, draftType: 'institutional_intro' as const };
    const checks = checkCopy({ drafts: [modelDraft(), modelDraft()] }, context);
    assert.match(checks[0]?.problems.join(' ') ?? '', /more than one draft/);
    assert.deepEqual(checks[1]?.problems, ['no draft was written for this target']);
  });

  it('in commercial mode, allows only implemented capabilities that are declared', async () => {
    const registry = await registryWith({ trips: { status: 'implemented' } });
    const commercial = { registry, draftType: 'commercial' as const };
    const body = `${NEUTRAL_BODY} A plataforma ajuda a organizar as viagens.`;

    assert.deepEqual((await checkOne(modelDraft({ body, capability_keys: ['trips'] }), commercial)).problems, []);
    assert.match(
      (await checkOne(modelDraft({ body, capability_keys: [] }), commercial)).problems.join(' '),
      /at least one capability/,
    );
    assert.match(
      (await checkOne(modelDraft({ body: `${body} A plataforma inclui rastreamento por GPS.`, capability_keys: ['trips'] }), commercial)).problems.join(' '),
      /"gps_telematics" is unverified/,
    );
    assert.match(
      (await checkOne(modelDraft({ body, capability_keys: ['trips', 'fuel'] }), commercial)).problems.join(' '),
      /"fuel" has status "unverified"/,
    );
    assert.match(
      (await checkOne(modelDraft({ body: `${NEUTRAL_BODY} O sistema regista as viagens.`, capability_keys: ['dashboard'] }), commercial)).problems.join(' '),
      /"dashboard" has status "unverified"|without listing it/,
    );
  });

  it('requires approval and a stated limitation for a partially implemented capability', async () => {
    const registry = await registryWith({
      trips: { status: 'implemented' },
      fuel: { status: 'partially_implemented', limitations: 'Regista compras; não calcula consumos.' },
    });
    const check = await checkOne(
      modelDraft({
        body: `${NEUTRAL_BODY} A plataforma organiza as viagens e regista as compras de combustível, sem calcular consumos.`,
        capability_keys: ['trips', 'fuel'],
      }),
      { registry, draftType: 'commercial' },
    );
    assert.deepEqual(check.problems, []);
    assert.equal(check.requires_capability_approval, true);
    assert.equal(check.flags.some((f) => f.includes('Regista compras; não calcula consumos.')), true);
  });
});

describe('Copywriter agent', () => {
  async function agentWith(replies: ScriptedReply[], config?: ProjectConfig) {
    const resolved = config ?? (await loadConfigWithSender());
    const llm = createScriptedLlm(replies);
    const agent = createCopywriterAgent({
      llm,
      registry: resolved.capabilities,
      outreach: resolved.outreach,
      prompt: TEST_PROMPT,
      retry: noSleepRetry,
    });
    return { agent, llm };
  }

  it('writes institutional drafts pending review while nothing is verified', async () => {
    const { agent, llm } = await agentWith([(request) => copyReply(request)]);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(result.status, 'ok');
    assert.equal(llm.requests.length, 1);
    if (result.status !== 'ok') return;
    const parsed = OutreachPackageSchema.safeParse(result.output);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(result.output.approval.status, 'pending_human_review');
    assert.equal(result.output.drafts.length, 5);
    for (const draft of result.output.drafts) {
      assert.equal(draft.draft_type, 'institutional_intro');
      assert.deepEqual(draft.capability_refs, []);
      assert.equal(draft.fact_refs.length, 1);
      assert.match(draft.fact_refs[0] ?? '', /^fact_/);
      assert.equal(draft.subject === null, draft.channel !== 'email');
    }
    assert.equal(result.output.drafts[0]?.addressed_to, 'João Exemplo');
    assert.equal(result.output.drafts[2]?.addressed_to, null);
    assert.equal(result.output.drafts[2]?.review_flags.some((f) => f.includes('Addressed to a role')), true);
    assert.equal(new Set(result.output.drafts.map((d) => d.draft_id)).size, 5);
  });

  it('gives the model only usable facts, the neutral description and no contact values', async () => {
    const { agent, llm } = await agentWith([(request) => copyReply(request)]);
    await agent.run(await makeDossier(), CONTEXT);
    const user = llm.requests[0]?.user ?? '';
    assert.match(user, /<mode>institutional_intro<\/mode>/);
    assert.equal(user.includes(NEUTRAL_PRODUCT_DESCRIPTION.pt), true);
    assert.equal(user.includes('investment'), false, 'low-confidence fact must not be offered');
    assert.equal(user.includes('geral@example.com'), false);
    assert.equal(user.includes('841234567'), false);
    assert.match(user, /<capabilities>\n\[\]\n<\/capabilities>/);
    assert.equal(targetsIn(llm.requests[0]!).length, 5);
  });

  it('asks once for a repair, naming the violation, and uses the corrected drafts', async () => {
    const bad = (request: Parameters<typeof copyReply>[0]) =>
      copyReply(request, (draft, target) =>
        target.target_id === 't1' ? { ...draft, body: `${NEUTRAL_BODY} Poupe 30% em combustível.` } : draft,
      );
    const { agent, llm } = await agentWith([bad, (request) => copyReply(request)]);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(llm.requests.length, 2);
    assert.match(llm.requests[1]?.user ?? '', /t1: must not contain percentages/);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(result.output.drafts.length, 5);
  });

  it('drops a draft that still violates the rules and keeps the others', async () => {
    const bad = (request: Parameters<typeof copyReply>[0]) =>
      copyReply(request, (draft, target) =>
        target.target_id === 't5' ? { ...draft, body: 'A nossa plataforma inclui rastreamento por GPS.' } : draft,
      );
    const { agent, llm } = await agentWith([bad]);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(llm.requests.length, 2);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.output.drafts.length, 4);
      assert.equal(result.output.drafts.some((d) => d.channel === 'whatsapp'), false);
      assert.equal(result.output.drafts.some((d) => /GPS/.test(d.body)), false);
    }
  });

  it('fails with a grounding violation when no draft passes', async () => {
    const bad = (request: Parameters<typeof copyReply>[0]) =>
      copyReply(request, (draft) => ({ ...draft, fact_ids: [] }));
    const { agent } = await agentWith([bad]);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'grounding_violation');
  });

  it('skips a company whose research is not solid enough, without calling the model', async () => {
    const reading = researchReading();
    reading.identity.is_same_company = false;
    const { agent, llm } = await agentWith([(request) => copyReply(request)]);
    const result = await agent.run(await makeDossier(reading), CONTEXT);
    assert.equal(result.status, 'skipped');
    if (result.status === 'skipped') assert.match(result.reason, /identity is not verified/);
    assert.equal(llm.requests.length, 0);
  });

  it('refuses to run until the sender is configured', async () => {
    const shipped = await loadConfigWithoutSender();
    assert.deepEqual(senderProblems(shipped.outreach), ['sender.name is not set', 'set sender.email or sender.phone']);
    const { agent, llm } = await agentWith([(request) => copyReply(request)], shipped);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.code, 'config');
    assert.equal(llm.requests.length, 0);
  });

  it('writes commercial drafts once a capability is verified as implemented', async () => {
    const config = await loadConfigWithSender(await registryWith({ trips: { status: 'implemented' } }));
    const commercial = (request: Parameters<typeof copyReply>[0]) =>
      copyReply(request, (draft) => ({
        ...draft,
        body: `${NEUTRAL_BODY} A plataforma ajuda a organizar as viagens.`,
        capability_keys: ['trips'],
      }));
    const { agent, llm } = await agentWith([commercial], config);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.match(llm.requests[0]?.user ?? '', /<mode>commercial<\/mode>/);
    assert.match(llm.requests[0]?.user ?? '', /"key": "trips"/);
    assert.equal((llm.requests[0]?.user ?? '').includes('"key": "fuel"'), false);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.output.drafts.every((d) => d.draft_type === 'commercial'), true);
      assert.deepEqual(result.output.drafts[0]?.capability_refs, ['trips']);
      assert.equal(OutreachPackageSchema.safeParse(result.output).success, true);
    }
  });

  it('ignores a draft for a target that was not requested', async () => {
    const extra = (request: Parameters<typeof copyReply>[0]) => {
      const reply = copyReply(request) as { drafts: unknown[] };
      return { drafts: [...reply.drafts, { ...(reply.drafts[0] as object), target_id: 't99' }] };
    };
    const { agent } = await agentWith([extra, (request) => copyReply(request)]);
    const result = await agent.run(await makeDossier(), CONTEXT);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(result.output.drafts.length, 5);
  });

  it('accepts the reference reply shape', async () => {
    const config = await loadConfigWithSender();
    const dossier = await makeDossier();
    const targets = buildTargets(dossier, config.outreach);
    const input = buildCopywriterInput(dossier, targets, config.capabilities, config.outreach, 'institutional_intro');
    const reply = copyReply({ model: '', system: '', user: input.text, maxTokens: 1, schemaName: '' });
    assert.equal(CopywriterModelOutputSchema.safeParse(reply).success, true);
    assert.deepEqual([...input.factIds.keys()], ['v1', 'v2', 'v3']);
  });
});

describe('outreach exports', () => {
  async function entry(): Promise<{ dossier: ResearchDossier; pkg: OutreachPackage; config: ProjectConfig }> {
    const config = await loadConfigWithSender();
    const dossier = await makeDossier();
    const agent = createCopywriterAgent({
      llm: createScriptedLlm([(request) => copyReply(request)]),
      registry: config.capabilities,
      outreach: config.outreach,
      prompt: TEST_PROMPT,
    });
    const result = await agent.run(dossier, CONTEXT);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    return { dossier, pkg: result.output, config };
  }

  it('adds the signature and opt-out line to make the full message', async () => {
    const { pkg, config } = await entry();
    const email = pkg.drafts.find((d) => d.channel === 'email');
    const whatsapp = pkg.drafts.find((d) => d.channel === 'whatsapp');
    assert.ok(email && whatsapp);
    assert.equal(
      signatureFor(email, config.outreach.sender),
      'Remetente Teste\nDirector Comercial, FleetOps MZ\ncomercial@fleetops.example | +258840000000 | https://fleetops.example',
    );
    assert.equal(signatureFor(whatsapp, config.outreach.sender), 'Remetente Teste\nDirector Comercial, FleetOps MZ');
    const message = fullMessage(email, config.outreach.sender);
    assert.ok(message.startsWith(NEUTRAL_BODY));
    assert.ok(message.endsWith(email.opt_out_line));
  });

  it('exports one CSV row per draft, all pending review, with where to send it', async () => {
    const { dossier, pkg, config } = await entry();
    const rows = parseCsv(outreachToCsv([{ dossier, pkg }], config.outreach.sender));
    assert.equal(rows.length, 6);
    const header = rows[0] ?? [];
    const column = (name: string): string[] => rows.slice(1).map((row) => row[header.indexOf(name)] ?? '');
    assert.deepEqual([...new Set(column('approval_status'))], ['pending_human_review']);
    assert.deepEqual(column('send_to'), [
      'geral@example.com',
      'https://www.linkedin.com/in/joao-exemplo',
      'geral@example.com',
      'geral@example.com',
      '+258841234567',
    ]);
    assert.equal(column('recipient_role')[3], 'Gestor de Frota');
    assert.ok(column('message')[0]?.includes('Remetente Teste'));
  });

  it('exports approved drafts with who approved them', async () => {
    const { dossier, pkg, config } = await entry();
    const draft = pkg.drafts[0];
    assert.ok(draft);
    const rows = parseCsv(
      approvedToCsv([{ entry: { dossier, pkg }, draft, reviewer: 'Gustavo', decided_at: '2026-11-13T00:00:00Z' }], config.outreach.sender),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.[(rows[0] ?? []).indexOf('approval_status')], 'approved');
    assert.equal(rows[1]?.at(-2), 'Gustavo');
  });

  it('renders review documents that say nothing was sent and separate hypotheses from findings', async () => {
    const { dossier, pkg, config } = await entry();
    const outreach = renderOutreachMarkdown({ dossier, pkg }, config.outreach.sender);
    assert.match(outreach, /pending human review\*\*\. Nothing has been sent/);
    assert.match(outreach, new RegExp(pkg.drafts[0]?.draft_id ?? 'missing'));
    assert.match(outreach, /Check before approving/);
    const document = renderDossierMarkdown(dossier);
    assert.match(document, /## Possible operational challenges \(hypotheses, not findings\)/);
    assert.match(document, /Operates a fleet of 25 trucks\. _\(confidence: high\)_/);
    assert.match(document, /Source: https:\/\/www\.example\.com\/sobre \(retrieved 2026-11-12\)/);
    assert.match(document, /João Exemplo/);
  });
});
