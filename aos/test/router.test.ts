/**
 * The router's guarantees, stated as tests rather than as comments.
 *
 * The one that matters most is "halts before spending". A budget checked after
 * the response arrives is a receipt, not a cap, and the difference is invisible
 * in code review unless something asserts the transport was never reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog, readEvents, eventsOfType } from '../src/core/events.ts';
import { deterministicSequencer } from '../src/core/ids.ts';
import { BudgetMeter, estimateCallUsd, estimatePromptTokens } from '../src/core/cost.ts';
import { ResponseCache, hashCall } from '../src/core/cache.ts';
import { callModel } from '../src/core/router.ts';
import type { RouterContext } from '../src/core/router.ts';
import { mockCatalog, normalizeCatalog, isMockModel, providerOf } from '../src/core/catalog.ts';
import { httpTransport, mockTransport } from '../src/core/transport.ts';
import type { Transport, TransportRequest } from '../src/core/transport.ts';
import { resolveRole, candidatesFor } from '../src/core/routing.ts';
import { AosError } from '../src/core/errors.ts';

const CATALOG = mockCatalog('https://example.invalid/v1', '2026-01-01T00:00:00.000Z');
const MODEL = 'anthropic/offline-stub-mid';

function fixture(budgetUsd: number, transport: Transport, cacheEnabled = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-router-'));
  const clock = deterministicSequencer('2026-01-01T00:00:00.000Z');
  const log = new EventLog(path.join(dir, 'events.jsonl'), clock);
  const ctx: RouterContext = {
    log,
    budget: new BudgetMeter(budgetUsd),
    cache: new ResponseCache(path.join(dir, '.cache'), cacheEnabled),
    catalog: CATALOG,
    transport,
  };
  return { dir, ctx, events: () => readEvents(log.file) };
}

const CALL = { role: 'ATLAS', model: MODEL, temperature: 0.2, maxTokens: 500 };
const MESSAGES = [{ role: 'user' as const, content: 'plan a tip calculator' }];

test('a call that would cross the cap never reaches the transport', async () => {
  let sent = 0;
  const transport = mockTransport(() => {
    sent++;
    return 'should never happen';
  });
  // Cap set far below the pre-flight estimate for a 500-token completion.
  const { dir, ctx, events } = fixture(0.000_001, transport);

  await assert.rejects(
    () => callModel(ctx, { ...CALL, messages: MESSAGES }),
    (err: unknown) => err instanceof AosError && err.code === 'BUDGET_EXCEEDED',
  );

  assert.equal(sent, 0, 'the transport was reached, so the cap is a receipt not a cap');
  assert.equal(ctx.budget.spentUsd, 0);

  const log = events();
  assert.equal(eventsOfType(log, 'budget.halt').length, 1);
  assert.equal(eventsOfType(log, 'model.response').length, 0);
  // The refused request is still in the audit trail.
  assert.equal(eventsOfType(log, 'model.request').length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the request is logged before the response, always', async () => {
  const { dir, ctx, events } = fixture(1, mockTransport(() => 'ok'));
  await callModel(ctx, { ...CALL, messages: MESSAGES });

  const log = events();
  const req = log.findIndex((e) => e.type === 'model.request');
  const res = log.findIndex((e) => e.type === 'model.response');
  assert.ok(req >= 0 && res >= 0);
  assert.ok(req < res, 'C5: the request must be on disk before the response is acted on');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('spend is recorded from real usage, not from the estimate', async () => {
  const { dir, ctx } = fixture(1, mockTransport(() => 'short'));
  const est = estimateCallUsd(CATALOG.models.find((m) => m.id === MODEL)!, MESSAGES, 500);
  const result = await callModel(ctx, { ...CALL, messages: MESSAGES });

  assert.ok(result.costUsd > 0);
  assert.ok(result.costUsd < est, 'a five-token reply should bill less than a 500-token worst case');
  assert.equal(ctx.budget.spentUsd, result.costUsd);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cache hit costs nothing and does not reach the transport', async () => {
  let sent = 0;
  const transport = mockTransport(() => {
    sent++;
    return 'first answer';
  });
  const { dir, ctx } = fixture(1, transport, true);

  const first = await callModel(ctx, { ...CALL, messages: MESSAGES });
  const second = await callModel(ctx, { ...CALL, messages: MESSAGES });

  assert.equal(sent, 1, 'the second identical call should have been served from disk');
  assert.equal(first.source, 'mock');
  assert.equal(second.source, 'cache');
  assert.equal(second.costUsd, 0);
  assert.equal(second.text, first.text);
  assert.equal(ctx.budget.spentUsd, first.costUsd);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cache key covers everything that changes an answer', () => {
  const base = { model: MODEL, temperature: 0.2, maxTokens: 500, messages: MESSAGES };
  const h = hashCall(base);
  assert.notEqual(h, hashCall({ ...base, temperature: 0.9 }));
  assert.notEqual(h, hashCall({ ...base, maxTokens: 501 }));
  assert.notEqual(h, hashCall({ ...base, model: 'google/offline-stub-cheap' }));
  assert.notEqual(h, hashCall({ ...base, messages: [{ role: 'user', content: 'different' }] }));
  assert.equal(h, hashCall({ ...base }), 'identical calls must collide, that is the point');
});

test('a slug missing from the catalog fails before any spend', async () => {
  const { dir, ctx } = fixture(1, mockTransport(() => 'ok'));
  await assert.rejects(
    () => callModel(ctx, { ...CALL, model: 'anthropic/claude-remembered-from-memory', messages: MESSAGES }),
    (err: unknown) => err instanceof AosError && err.code === 'MODEL_UNRESOLVED',
  );
  assert.equal(ctx.budget.spentUsd, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the http transport refuses to send an offline stub slug', async () => {
  const t = httpTransport({ baseUrl: 'https://example.invalid/v1', apiKey: 'unused' });
  const req: TransportRequest = {
    model: MODEL,
    messages: MESSAGES,
    temperature: 0.2,
    maxTokens: 10,
    jsonMode: false,
    hash: 'x',
  };
  await assert.rejects(
    () => t.send(req),
    (err: unknown) => err instanceof AosError && err.code === 'ROUTER' && /offline stub/.test(err.message),
  );
  assert.ok(isMockModel(MODEL));
});

test('the pre-flight estimate over-estimates rather than under-estimates', () => {
  // Under-estimating leaks money past the cap; over-estimating stops early.
  const text = 'the quick brown fox jumps over the lazy dog, repeatedly and at length';
  const est = estimatePromptTokens([{ role: 'user', content: text }]);
  const realistic = Math.ceil(text.length / 4);
  assert.ok(est > realistic, `estimate ${est} should exceed a ~4 chars/token reading of ${realistic}`);
});

test('a role resolves to a provider-diverse fallback', () => {
  const catalog = normalizeCatalog(
    {
      data: [
        { id: 'alpha/small', context_length: 200000, pricing: { prompt: '0.0000002', completion: '0.0000008' } },
        { id: 'alpha/large', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'beta/small', context_length: 200000, pricing: { prompt: '0.0000004', completion: '0.0000012' } },
        { id: 'alpha/embedding-v1', context_length: 200000, pricing: { prompt: '0.0000001', completion: '0' } },
        { id: 'alpha/tiny-context', context_length: 4096, pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      ],
    },
    'https://example.invalid/v1',
    '2026-01-01T00:00:00.000Z',
    'live',
  );

  const res = resolveRole(catalog, 'ECHO', { prefer: ['alpha', 'beta'], tier: 'cheap', minContext: 100000, secondOpinion: true });
  assert.equal(res.model, 'alpha/small');
  assert.equal(res.fallback, 'beta/small');
  assert.notEqual(providerOf(res.model), providerOf(res.fallback), 'a fallback sharing an outage is not a fallback');

  const candidates = candidatesFor(catalog, 'alpha', 100000).map((m) => m.id);
  assert.deepEqual(candidates, ['alpha/small', 'alpha/large'], 'embeddings and short-context models are filtered out');
});

test('no model in the catalog matching a role is a loud failure', () => {
  assert.throws(
    () => resolveRole(CATALOG, 'MUSE', { prefer: ['nobody-serves-this'], tier: 'cheap', minContext: 32000, secondOpinion: false }),
    (err: unknown) => err instanceof AosError && err.code === 'MODEL_UNRESOLVED',
  );
});
