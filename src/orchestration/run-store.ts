import type { JsonCache } from '../agents/structured-call.js';
import { comparisonKey } from '../domain/normalize.js';
import { PipelineError } from '../infra/errors.js';
import type { RecordStore } from '../ports/store.js';

/** Where each stage reads and writes, relative to the project root. */
export const STAGE_PATHS = {
  qualified: { runs: 'data/qualified/runs', latest: 'data/qualified/LATEST', cache: 'data/qualified/cache' },
  researched: {
    runs: 'data/researched/runs',
    latest: 'data/researched/LATEST',
    cache: 'data/researched/cache/model',
    searchCache: 'data/researched/cache/search',
  },
  outreach: {
    runs: 'data/outreach_ready/runs',
    latest: 'data/outreach_ready/LATEST',
    cache: 'data/outreach_ready/cache',
  },
  reviews: { promotions: 'data/reviews/promotions.csv', approvals: 'data/reviews/approvals.csv' },
  runParams: 'data/runs',
  reports: 'data/reports',
} as const;

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A cache of JSON values stored one file per key under `directory`. */
export function createJsonCache(store: RecordStore, directory: string): JsonCache {
  const pathOf = (key: string): string => `${directory}/${key}.json`;
  return {
    async get(key) {
      const path = pathOf(key);
      if (!(await store.exists(path))) return null;
      try {
        return await store.readJson(path);
      } catch {
        // A damaged cache entry is ignored; the work is simply redone.
        return null;
      }
    },
    async set(key, value) {
      await store.writeState(pathOf(key), toJson(value));
    },
  };
}

/** Resolves the run to read from: the one given, or the stage's newest run. */
export async function resolveSourceRun(
  store: RecordStore,
  stage: { runs: string; latest: string },
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    if ((await store.list(`${stage.runs}/${requested}`)).length === 0) {
      throw new PipelineError({
        code: 'config',
        message: `Run not found: ${stage.runs}/${requested}`,
      });
    }
    return requested;
  }
  if (!(await store.exists(stage.latest))) {
    throw new PipelineError({
      code: 'config',
      message: `No earlier run found (${stage.latest} is missing). Run the previous agent first.`,
    });
  }
  return (await store.readText(stage.latest)).trim();
}

/**
 * Safe, readable file stem for one company, e.g.
 * "beira_transportes-exemplo_b58bf4be_2026-11-12". The lead_id fragment keeps
 * names unique when two companies share a name and city.
 */
export function companyFileStem(input: {
  city: string | null;
  company_name: string;
  lead_id: string;
  date: string;
}): string {
  const slug = (text: string): string => comparisonKey(text).replace(/ /g, '-').slice(0, 50);
  const city = input.city === null ? 'sem-cidade' : slug(input.city) || 'sem-cidade';
  const name = slug(input.company_name) || 'empresa';
  return `${city}_${name}_${input.lead_id.replace(/^lead_/, '').slice(0, 8)}_${input.date.slice(0, 10)}`;
}
