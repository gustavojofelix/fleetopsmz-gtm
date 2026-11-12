import { z } from 'zod';
import type { ZodType, ZodTypeDef } from 'zod';
import { PipelineError } from '../infra/errors.js';
import type { RecordStore } from '../ports/store.js';
import {
  OutreachPackageSchema,
  QualifiedLeadSchema,
  ResearchDossierSchema,
} from '../schemas/index.js';
import type {
  ApprovalRecord,
  OutreachPackage,
  PromotionRecord,
  QualifiedLead,
  ResearchDossier,
} from '../schemas/index.js';
import { latestDecisions, parseApprovalsCsv, parsePromotionsCsv } from '../tools/reviews.js';
import { STAGE_PATHS } from './run-store.js';

async function readValidated<T>(
  store: RecordStore,
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  if (!(await store.exists(path))) {
    throw new PipelineError({ code: 'config', message: `File not found: ${path}` });
  }
  const parsed = schema.safeParse(await store.readJson(path));
  if (!parsed.success) {
    throw new PipelineError({
      code: 'input_validation',
      message: `${path} does not match the expected schema`,
      context: {
        problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

export const RUN_FILES = {
  leads: 'qualified_companies.json',
  dossiers: 'dossiers.json',
  packages: 'outreach_packages.json',
} as const;

export function loadQualifiedLeads(store: RecordStore, runId: string): Promise<QualifiedLead[]> {
  return readValidated(
    store,
    `${STAGE_PATHS.qualified.runs}/${runId}/${RUN_FILES.leads}`,
    z.array(QualifiedLeadSchema),
  );
}

export function loadDossiers(store: RecordStore, runId: string): Promise<ResearchDossier[]> {
  return readValidated(
    store,
    `${STAGE_PATHS.researched.runs}/${runId}/${RUN_FILES.dossiers}`,
    z.array(ResearchDossierSchema),
  );
}

export function loadPackages(store: RecordStore, runId: string): Promise<OutreachPackage[]> {
  return readValidated(
    store,
    `${STAGE_PATHS.outreach.runs}/${runId}/${RUN_FILES.packages}`,
    z.array(OutreachPackageSchema),
  );
}

export interface ReviewDecisions<T> {
  latest: Map<string, T>;
  problems: string[];
}

/** Latest manual promotion per lead. A missing file means no decisions yet. */
export async function loadPromotions(store: RecordStore): Promise<ReviewDecisions<PromotionRecord>> {
  const path = STAGE_PATHS.reviews.promotions;
  if (!(await store.exists(path))) return { latest: new Map(), problems: [] };
  const { records, problems } = parsePromotionsCsv(await store.readText(path));
  return { latest: latestDecisions(records, (r) => r.lead_id), problems };
}

/** Latest approval decision per draft. A missing file means nothing is approved. */
export async function loadApprovals(store: RecordStore): Promise<ReviewDecisions<ApprovalRecord>> {
  const path = STAGE_PATHS.reviews.approvals;
  if (!(await store.exists(path))) return { latest: new Map(), problems: [] };
  const { records, problems } = parseApprovalsCsv(await store.readText(path));
  return { latest: latestDecisions(records, (r) => r.draft_id), problems };
}

/**
 * Reads one file from every finished run of a stage, oldest first. Runs that
 * did not finish (no such file) are skipped; unreadable ones are reported.
 */
export async function loadFromAllRuns<T>(
  store: RecordStore,
  runsDir: string,
  fileName: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<{ runs: { run_id: string; data: T }[]; problems: string[] }> {
  const runs: { run_id: string; data: T }[] = [];
  const problems: string[] = [];
  for (const runId of await store.list(runsDir)) {
    const path = `${runsDir}/${runId}/${fileName}`;
    if (!(await store.exists(path))) continue;
    try {
      const parsed = schema.safeParse(await store.readJson(path));
      if (parsed.success) runs.push({ run_id: runId, data: parsed.data });
      else problems.push(`${path}: does not match the expected schema`);
    } catch {
      problems.push(`${path}: could not be read`);
    }
  }
  return { runs, problems };
}

/** Keeps the most recent item per key, given runs ordered oldest first. */
export function latestPerKey<T>(
  runs: readonly { data: readonly T[] }[],
  keyOf: (item: T) => string,
): T[] {
  const latest = new Map<string, T>();
  for (const run of runs) for (const item of run.data) latest.set(keyOf(item), item);
  return [...latest.values()];
}
