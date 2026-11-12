import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { loadProjectConfig, parseConfig } from '../../src/config/project-config.js';
import { commercialDraftsEnabled } from '../../src/domain/capability-gate.js';
import { isPipelineError } from '../../src/infra/errors.js';
import { RAW_INPUT_COLUMNS, ScoringConfigSchema } from '../../src/schemas/index.js';

/** Tests run from the project root (npm test). */
const ROOT = process.cwd();

describe('files under config/', () => {
  it('all load and validate', async () => {
    const config = await loadProjectConfig(ROOT);
    assert.ok(config.capabilities.capabilities.length > 0);
    assert.ok(config.geography.cities.length > 0);
  });

  it('ship with every capability unverified, so commercial drafts are disabled', async () => {
    const { capabilities } = await loadProjectConfig(ROOT);
    for (const capability of capabilities.capabilities) {
      assert.equal(capability.status, 'unverified', `capability ${capability.key}`);
      assert.equal(capability.verified_by, null);
    }
    assert.equal(commercialDraftsEnabled(capabilities), false);
  });

  it('use the 100-point model and the approved thresholds', async () => {
    const { scoring } = await loadProjectConfig(ROOT);
    assert.equal(scoring.criteria.reduce((sum, c) => sum + c.max, 0), 100);
    assert.deepEqual(scoring.bands, { A: 80, B: 60, C: 40 });
    assert.deepEqual(scoring.auto_research_priorities, ['A', 'B']);
  });

  it('map Beira to Sofala as the first commercial priority', async () => {
    const { geography } = await loadProjectConfig(ROOT);
    const beira = geography.cities.find((c) => c.city === 'Beira');
    assert.equal(beira?.province, 'Sofala');
    assert.equal(beira?.priority_rank, 1);
  });
});

describe('parseConfig', () => {
  it('throws a config error naming the file when validation fails', () => {
    try {
      parseConfig(ScoringConfigSchema, { schema_version: 1 }, 'config/scoring.json');
      assert.fail('expected a config error');
    } catch (error) {
      assert.ok(isPipelineError(error));
      assert.equal(error.code, 'config');
      assert.match(error.message, /config\/scoring\.json/);
    }
  });
});

describe('raw input template', () => {
  it('has exactly the standard columns, in order', async () => {
    const text = await readFile(`${ROOT}/templates/raw_companies_template.csv`, 'utf8');
    const header = text.split(/\r?\n/)[0];
    assert.equal(header, RAW_INPUT_COLUMNS.join(','));
  });

  it('has a JSON template with the same keys', async () => {
    const text = await readFile(`${ROOT}/templates/raw_companies_template.json`, 'utf8');
    const rows = JSON.parse(text) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(rows[0] ?? {}), [...RAW_INPUT_COLUMNS]);
  });
});
