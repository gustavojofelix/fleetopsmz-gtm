import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityEntrySchema,
  FactSchema,
  IcpAssessmentSchema,
  OutreachDraftSchema,
  OutreachPackageSchema,
  PublicContactSchema,
  QualifiedLeadSchema,
  RAW_INPUT_COLUMNS,
  RawCompanyInputSchema,
  ResearchDossierSchema,
} from '../../src/schemas/index.js';
import {
  capability,
  contact,
  dossier,
  draft,
  fact,
  icp,
  outreachPackage,
  qualifiedLead,
  sourceRef,
} from '../fixtures.js';

describe('RawCompanyInputSchema', () => {
  it('accepts a row with only company_name and sets the rest to null', () => {
    const row = RawCompanyInputSchema.parse({ company_name: '  Transportes Exemplo, Lda ' });
    assert.equal(row.company_name, 'Transportes Exemplo, Lda');
    for (const column of RAW_INPUT_COLUMNS) {
      if (column !== 'company_name') assert.equal(row[column], null);
    }
  });

  it('turns blank strings into null instead of keeping empty values', () => {
    const row = RawCompanyInputSchema.parse({ company_name: 'X', city: '   ', phone: '' });
    assert.equal(row.city, null);
    assert.equal(row.phone, null);
  });

  it('rejects a row without company_name', () => {
    assert.equal(RawCompanyInputSchema.safeParse({ city: 'Beira' }).success, false);
    assert.equal(RawCompanyInputSchema.safeParse({ company_name: '   ' }).success, false);
  });
});

describe('FactSchema', () => {
  it('accepts a verified fact with a URL source', () => {
    assert.equal(FactSchema.safeParse(fact()).success, true);
  });

  it('rejects a verified fact without sources', () => {
    assert.equal(FactSchema.safeParse(fact({ sources: [] })).success, false);
  });

  it('rejects a verified fact whose only source has no URL', () => {
    const importOnly = fact({ sources: [sourceRef({ url: null, source_type: 'import', provider: null })] });
    assert.equal(FactSchema.safeParse(importOnly).success, false);
  });

  it('accepts a hypothesis without sources', () => {
    assert.equal(FactSchema.safeParse(fact({ kind: 'hypothesis', sources: [] })).success, true);
  });
});

describe('PublicContactSchema', () => {
  it('accepts a corporate contact', () => {
    assert.equal(PublicContactSchema.safeParse(contact()).success, true);
  });

  it('rejects a named_person contact without a name', () => {
    assert.equal(PublicContactSchema.safeParse(contact({ scope: 'named_person' })).success, false);
  });
});

describe('IcpAssessmentSchema', () => {
  it('accepts a complete assessment whose score equals the sum of points', () => {
    assert.equal(IcpAssessmentSchema.safeParse(icp()).success, true);
  });

  it('rejects a score that does not match the criteria', () => {
    assert.equal(IcpAssessmentSchema.safeParse(icp({ score: 90 })).success, false);
  });

  it('rejects a missing criterion', () => {
    const base = icp() as { criteria: unknown[] };
    const incomplete = { ...base, criteria: base.criteria.slice(1), score: 60 };
    assert.equal(IcpAssessmentSchema.safeParse(incomplete).success, false);
  });

  it('rejects points on a criterion whose basis is unknown', () => {
    const base = icp() as { criteria: Record<string, unknown>[] };
    const criteria = base.criteria.map((c) =>
      c['key'] === 'digital_maturity' ? { ...c, points: 3 } : c,
    );
    assert.equal(IcpAssessmentSchema.safeParse({ ...base, criteria, score: 81 }).success, false);
  });

  it('rejects an evidence-based criterion without fact references', () => {
    const base = icp() as { criteria: Record<string, unknown>[] };
    const criteria = base.criteria.map((c) =>
      c['key'] === 'fleet_activity' ? { ...c, fact_refs: [] } : c,
    );
    assert.equal(IcpAssessmentSchema.safeParse({ ...base, criteria }).success, false);
  });
});

describe('QualifiedLeadSchema', () => {
  it('accepts a valid lead', () => {
    const result = QualifiedLeadSchema.safeParse(qualifiedLead());
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('rejects the retired company_id field', () => {
    assert.equal(QualifiedLeadSchema.safeParse(qualifiedLead({ company_id: 'x' })).success, false);
  });

  it('rejects a malformed lead_id', () => {
    assert.equal(QualifiedLeadSchema.safeParse(qualifiedLead({ lead_id: 'company-1' })).success, false);
  });

  it('requires a reason for manual review', () => {
    const held = qualifiedLead({ qualification_status: 'manual_review' });
    assert.equal(QualifiedLeadSchema.safeParse(held).success, false);
    const explained = qualifiedLead({
      qualification_status: 'manual_review',
      review_reason: 'insufficient_information',
    });
    assert.equal(QualifiedLeadSchema.safeParse(explained).success, true);
  });

  it('requires duplicate_of for a duplicate', () => {
    const duplicate = qualifiedLead({ qualification_status: 'duplicate' });
    assert.equal(QualifiedLeadSchema.safeParse(duplicate).success, false);
  });

  it('keeps unknown values as null', () => {
    const sparse = qualifiedLead({ website: null, city: null, province: null, sub_segment: null });
    assert.equal(QualifiedLeadSchema.safeParse(sparse).success, true);
  });
});

describe('ResearchDossierSchema', () => {
  it('accepts a dossier that embeds a valid Agent 1 output (contract)', () => {
    const lead = QualifiedLeadSchema.parse(qualifiedLead());
    const result = ResearchDossierSchema.safeParse(dossier({ lead }));
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('rejects a hypothesis placed among verified facts', () => {
    const mixed = dossier({ facts: [fact({ kind: 'hypothesis', sources: [] })] });
    assert.equal(ResearchDossierSchema.safeParse(mixed).success, false);
  });

  it('rejects a verified fact placed among hypotheses', () => {
    assert.equal(ResearchDossierSchema.safeParse(dossier({ challenge_hypotheses: [fact()] })).success, false);
  });

  it('rejects identity_verified without identity evidence', () => {
    assert.equal(ResearchDossierSchema.safeParse(dossier({ identity_evidence: [] })).success, false);
  });

  it('rejects a lead snapshot with a different lead_id', () => {
    const other = dossier({ lead_id: 'lead_ffffffffffffffff' });
    assert.equal(ResearchDossierSchema.safeParse(other).success, false);
  });
});

describe('OutreachDraftSchema and OutreachPackageSchema', () => {
  it('accepts an institutional introduction without capability references', () => {
    assert.equal(OutreachDraftSchema.safeParse(draft()).success, true);
  });

  it('rejects an institutional introduction that references a capability', () => {
    assert.equal(OutreachDraftSchema.safeParse(draft({ capability_refs: ['trips'] })).success, false);
  });

  it('rejects a commercial draft without capability references', () => {
    assert.equal(OutreachDraftSchema.safeParse(draft({ draft_type: 'commercial' })).success, false);
  });

  it('requires a subject for email but not for WhatsApp', () => {
    assert.equal(OutreachDraftSchema.safeParse(draft({ subject: null })).success, false);
    assert.equal(
      OutreachDraftSchema.safeParse(draft({ channel: 'whatsapp', subject: null })).success,
      true,
    );
  });

  it('requires an opt-out line', () => {
    assert.equal(OutreachDraftSchema.safeParse(draft({ opt_out_line: '' })).success, false);
  });

  it('accepts a package awaiting human review', () => {
    const result = OutreachPackageSchema.safeParse(outreachPackage());
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('never lets an agent emit an approved package', () => {
    const approved = outreachPackage({ approval: { status: 'approved' } });
    assert.equal(OutreachPackageSchema.safeParse(approved).success, false);
  });

  it('rejects duplicate draft IDs', () => {
    assert.equal(OutreachPackageSchema.safeParse(outreachPackage({ drafts: [draft(), draft()] })).success, false);
  });
});

describe('CapabilityEntrySchema', () => {
  it('accepts an unverified capability', () => {
    assert.equal(CapabilityEntrySchema.safeParse(capability()).success, true);
  });

  it('rejects "implemented" without a verifier and date', () => {
    assert.equal(CapabilityEntrySchema.safeParse(capability({ status: 'implemented' })).success, false);
  });

  it('accepts "implemented" once a person has verified it', () => {
    const verified = capability({
      status: 'implemented',
      verified_by: 'Reviewer',
      verified_at: '2026-11-12T16:40:00Z',
    });
    assert.equal(CapabilityEntrySchema.safeParse(verified).success, true);
  });

  it('rejects "partially_implemented" without limitations', () => {
    const partial = capability({
      status: 'partially_implemented',
      verified_by: 'Reviewer',
      verified_at: '2026-11-12T16:40:00Z',
    });
    assert.equal(CapabilityEntrySchema.safeParse(partial).success, false);
  });

  it('rejects a status outside the five allowed values', () => {
    assert.equal(CapabilityEntrySchema.safeParse(capability({ status: 'beta' })).success, false);
  });
});
