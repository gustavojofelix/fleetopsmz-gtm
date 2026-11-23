import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createAnthropicLlmClient,
  extractJsonObject,
  mapProviderError,
} from '../../src/adapters/anthropic.js';
import type { MessageCreateParams, MessageResponse } from '../../src/adapters/anthropic.js';
import { createFsStore } from '../../src/adapters/fs-store.js';
import { isPipelineError } from '../../src/infra/errors.js';
import { mapWithConcurrency } from '../../src/infra/concurrency.js';
import { createRunId } from '../../src/orchestration/run-id.js';
import { RunIdSchema } from '../../src/schemas/index.js';

const REQUEST = {
  model: 'test-model',
  system: 'System prompt.',
  user: 'User message.',
  maxTokens: 500,
  schemaName: 'thing',
  jsonSchema: { type: 'object' },
};

function apiReturning(response: Partial<MessageResponse>) {
  const calls: MessageCreateParams[] = [];
  return {
    calls,
    create: async (params: MessageCreateParams): Promise<MessageResponse> => {
      calls.push(params);
      return {
        content: [],
        model: 'test-model-resolved',
        stop_reason: 'tool_use',
        usage: { input_tokens: 11, output_tokens: 7 },
        ...response,
      };
    },
  };
}

function httpError(status: number, headers?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

describe('Anthropic adapter', () => {
  it('asks for one tool call without forcing it, and returns the tool input', async () => {
    const api = apiReturning({
      content: [
        { type: 'text' },
        { type: 'tool_use', name: 'record_thing', input: { ok: true } },
      ],
    });
    const response = await createAnthropicLlmClient(api).completeJson(REQUEST);
    assert.deepEqual(response.json, { ok: true });
    assert.deepEqual(response.usage, { input_tokens: 11, output_tokens: 7 });
    assert.equal(response.model, 'test-model-resolved');

    const sent = api.calls[0];
    assert.equal(sent?.model, 'test-model');
    assert.equal(sent?.max_tokens, 500);
    assert.equal(sent?.system, 'System prompt.');
    assert.equal(sent?.messages.length, 1);
    assert.ok(sent?.messages[0]?.content.startsWith('User message.'));
    assert.match(sent?.messages[0]?.content ?? '', /calling the `record_thing` tool exactly once/);
    // Current Claude models reject tool_choice "tool" and "any" with a 400 error.
    assert.deepEqual(sent?.tool_choice, { type: 'auto' });
    assert.deepEqual(sent?.tools[0]?.input_schema, { type: 'object' });
  });

  it('accepts a JSON object in a text reply when the tool was not called', async () => {
    const client = createAnthropicLlmClient(
      apiReturning({
        stop_reason: 'end_turn',
        content: [{ type: 'thinking' }, { type: 'text', text: 'Here it is:\n```json\n{"ok": true, "n": 2}\n```' }],
      }),
    );
    assert.deepEqual((await client.completeJson(REQUEST)).json, { ok: true, n: 2 });
    assert.equal(extractJsonObject('no json here'), undefined);
    assert.equal(extractJsonObject('{broken'), undefined);
  });

  it('reports a reply without a structured result as invalid model output', async () => {
    const client = createAnthropicLlmClient(apiReturning({ content: [{ type: 'text' }] }));
    await assert.rejects(client.completeJson(REQUEST), (error: unknown) =>
      isPipelineError(error) && error.code === 'model_output_invalid',
    );
  });

  it('reports a truncated reply as invalid model output', async () => {
    const client = createAnthropicLlmClient(
      apiReturning({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', name: 'record_thing', input: { partial: true } }],
      }),
    );
    await assert.rejects(client.completeJson(REQUEST), (error: unknown) =>
      isPipelineError(error) && error.code === 'model_output_invalid',
    );
  });

  it('maps provider failures thrown by the API', async () => {
    const client = createAnthropicLlmClient({
      create: async () => {
        throw httpError(503);
      },
    });
    await assert.rejects(client.completeJson(REQUEST), (error: unknown) =>
      isPipelineError(error) && error.code === 'provider_transient' && error.retryable,
    );
  });
});

describe('mapProviderError', () => {
  it('maps 429 to rate_limited and reads retry-after from either header shape', () => {
    const plain = mapProviderError(httpError(429, { 'retry-after': '7' }));
    assert.equal(plain.code, 'rate_limited');
    assert.equal(plain.retryAfterMs, 7_000);
    const fetchStyle = mapProviderError(httpError(429, new Headers({ 'retry-after': '3' })));
    assert.equal(fetchStyle.retryAfterMs, 3_000);
    assert.equal(mapProviderError(httpError(429)).retryAfterMs, undefined);
  });

  it('maps server and network errors to retryable transient failures', () => {
    for (const error of [httpError(500), httpError(529), httpError(408), new Error('socket hang up')]) {
      const mapped = mapProviderError(error);
      assert.equal(mapped.code, 'provider_transient');
      assert.equal(mapped.retryable, true);
    }
  });

  it('maps client errors to permanent failures with a key hint for 401', () => {
    assert.equal(mapProviderError(httpError(400)).code, 'provider_permanent');
    assert.equal(mapProviderError(httpError(400)).retryable, false);
    assert.match(mapProviderError(httpError(401)).message, /API key/);
  });
});

describe('filesystem store', () => {
  it('writes, reads and lists files under the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleetops-store-'));
    const store = createFsStore(root);
    assert.equal(await store.exists('data/a.json'), false);
    await store.writeNew('data/a.json', '{"a":1}');
    assert.equal(await store.exists('data/a.json'), true);
    assert.deepEqual(await store.readJson('data/a.json'), { a: 1 });
    await store.appendLine('data/log.jsonl', 'one');
    await store.appendLine('data/log.jsonl', 'two');
    assert.equal(await store.readText('data/log.jsonl'), 'one\ntwo\n');
    assert.deepEqual(await store.list('data'), ['a.json', 'log.jsonl']);
    assert.deepEqual(await store.list('missing'), []);
  });

  it('refuses to overwrite with writeNew and leaves the original intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleetops-store-'));
    const store = createFsStore(root);
    await store.writeNew('run/out.json', 'first');
    await assert.rejects(store.writeNew('run/out.json', 'second'), (error: unknown) =>
      isPipelineError(error) && error.code === 'io' && /overwrite/.test(error.message),
    );
    assert.equal(await readFile(join(root, 'run/out.json'), 'utf8'), 'first');
  });

  it('replaces state atomically without leaving temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleetops-store-'));
    const store = createFsStore(root);
    await store.writeState('state/registry.json', 'v1');
    await store.writeState('state/registry.json', 'v2');
    assert.equal(await store.readText('state/registry.json'), 'v2');
    assert.deepEqual(await readdir(join(root, 'state')), ['registry.json']);
  });

  it('rejects paths outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleetops-store-'));
    const store = createFsStore(root);
    await assert.rejects(store.writeNew('../escape.txt', 'x'), (error: unknown) =>
      isPipelineError(error) && error.code === 'io',
    );
  });
});

describe('run helpers', () => {
  it('creates run IDs in the documented format', () => {
    const id = createRunId(new Date('2026-11-12T16:40:59Z'), () => 0);
    assert.equal(id, '2026-11-12T1640Z_aaaaaa');
    assert.equal(RunIdSchema.safeParse(id).success, true);
    assert.equal(RunIdSchema.safeParse(createRunId(new Date(), () => 0.999999)).success, true);
    assert.equal(RunIdSchema.safeParse(createRunId(new Date())).success, true);
  });

  it('keeps result order and never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 10;
    });
    assert.deepEqual(results, [50, 10, 30, 20, 40]);
    assert.equal(peak, 2);
    assert.deepEqual(await mapWithConcurrency([], 3, async (v: number) => v), []);
  });
});
