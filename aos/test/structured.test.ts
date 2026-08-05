/**
 * The repair ladder, and the schemas that make a role's refusal enforceable.
 *
 * The attempt count is asserted explicitly in every case. "Retries until it
 * works" is how a $1 run becomes a $40 run, and the only defence is a number
 * that a test will notice changing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { EventLog, readEvents, eventsOfType } from '../src/core/events.ts';
import { deterministicSequencer } from '../src/core/ids.ts';
import { BudgetMeter } from '../src/core/cost.ts';
import { ResponseCache } from '../src/core/cache.ts';
import { mockCatalog } from '../src/core/catalog.ts';
import { mockTransport } from '../src/core/transport.ts';
import { callStructured, extractJson, describeSchema } from '../src/core/structured.ts';
import type { RouterContext } from '../src/core/router.ts';
import type { RuntimeRole } from '../src/core/roles.ts';
import { CritiqueReport, IdeaSet, SCHEMAS } from '../src/roles/outputs.ts';
import { AosError } from '../src/core/errors.ts';

const Shape = z.object({ answer: z.string().min(1), confidence: z.number().min(0).max(1) });

const ROLE: RuntimeRole = {
  name: 'TESTER',
  title: 'test role',
  temperature: 0.2,
  maxTokens: 200,
  schemaName: 'Plan',
  schema: SCHEMAS.Plan,
  mustDifferFrom: [],
  systemPrompt: 'You are a test role that exists to exercise the repair ladder in this project.',
  model: 'anthropic/offline-stub-mid',
  fallback: 'openai/offline-stub-mid',
  parallel: [],
};

/** Returns scripted replies in order, so an attempt ladder is directly testable. */
function scripted(replies: string[]) {
  const seen: string[] = [];
  const transport = mockTransport((req) => {
    seen.push(req.model);
    return replies[seen.length - 1] ?? replies.at(-1)!;
  });
  return { transport, seen };
}

function fixture(replies: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-structured-'));
  const { transport, seen } = scripted(replies);
  const log = new EventLog(path.join(dir, 'events.jsonl'), deterministicSequencer('2026-01-01T00:00:00.000Z'));
  const ctx: RouterContext = {
    log,
    budget: new BudgetMeter(10),
    cache: new ResponseCache(path.join(dir, '.cache'), false),
    catalog: mockCatalog('https://example.invalid/v1', '2026-01-01T00:00:00.000Z'),
    transport,
  };
  return { dir, ctx, seen, events: () => readEvents(log.file) };
}

const GOOD = JSON.stringify({ answer: 'forty two', confidence: 0.8 });

test('valid on the first try costs one call', async () => {
  const { dir, ctx, seen } = fixture([GOOD]);
  const out = await callStructured(ctx, { role: ROLE, messages: [{ role: 'user', content: 'go' }], schema: Shape });
  assert.equal(out.attempts, 1);
  assert.equal(out.value.answer, 'forty two');
  assert.deepEqual(seen, [ROLE.model]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one bad reply is repaired on the same model, and the repair is logged', async () => {
  const { dir, ctx, seen, events } = fixture([JSON.stringify({ answer: '', confidence: 5 }), GOOD]);
  const out = await callStructured(ctx, { role: ROLE, messages: [{ role: 'user', content: 'go' }], schema: Shape });

  assert.equal(out.attempts, 2);
  assert.deepEqual(seen, [ROLE.model, ROLE.model], 'the repair stays on the primary model');

  const repairs = eventsOfType(events(), 'model.repair');
  assert.equal(repairs.length, 1);
  assert.match(repairs[0]!.issues, /confidence/, 'the model is handed the actual validation errors');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two failures escalate to the fallback model, exactly once', async () => {
  const { dir, ctx, seen } = fixture(['not json at all', '{"answer": 12}', GOOD]);
  const out = await callStructured(ctx, { role: ROLE, messages: [{ role: 'user', content: 'go' }], schema: Shape });

  assert.equal(out.attempts, 3);
  assert.deepEqual(seen, [ROLE.model, ROLE.model, ROLE.fallback]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('three failures halt rather than retrying into the budget', async () => {
  const { dir, ctx, seen } = fixture(['nope', 'still nope', 'nope again', 'would have worked']);
  await assert.rejects(
    () => callStructured(ctx, { role: ROLE, messages: [{ role: 'user', content: 'go' }], schema: Shape }),
    (err: unknown) => err instanceof AosError && err.code === 'SCHEMA_VIOLATION',
  );
  assert.equal(seen.length, 3, 'the ladder is fixed at three attempts, not "until it works"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON is recovered from fences and from prose, without burning a repair', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here is the object:\n\n{"a":1}\n\nHope that helps.'), { a: 1 });
  assert.deepEqual(extractJson('prefix [1,2,3] suffix'), [1, 2, 3]);
  // Braces inside strings must not close the object early.
  assert.deepEqual(extractJson('text {"a":"}{"} more'), { a: '}{' });
  assert.throws(
    () => extractJson('there is no json here'),
    (err: unknown) => err instanceof AosError && err.code === 'SCHEMA_VIOLATION',
  );
});

test('the schema shown to the model is generated from the schema that validates', () => {
  const described = describeSchema(SCHEMAS.BuildResult);
  assert.match(described, /runnable/, 'the model is told about the field the delivery gate reads');
  assert.match(described, /contents/);
});

test('ECHO cannot return praise, because the schema has no shape for it', () => {
  assert.equal(CritiqueReport.safeParse({ objections: [], noObjection: false }).success, false);
  assert.equal(
    CritiqueReport.safeParse({ objections: [], noObjection: true, testThatWouldCreateOne: 'too short' }).success,
    false,
  );
  assert.equal(
    CritiqueReport.safeParse({
      objections: [],
      noObjection: true,
      testThatWouldCreateOne: 'Enter a negative bill amount and check the tip is not negative.',
    }).success,
    true,
  );
  assert.equal(
    CritiqueReport.safeParse({
      objections: [{ claim: 'The parse result is never checked for NaN', severity: 'S2', falsifier: 'Enter "abc"' }],
    }).success,
    true,
  );
});

test('MUSE cannot pick a winner, because there is no field for one', () => {
  const three = Array.from({ length: 3 }, (_, i) => ({
    title: `Option ${i}`,
    sketch: 'A sketch long enough to satisfy the schema minimum length.',
    whyNot: 'A real reason to reject this.',
  }));
  assert.equal(IdeaSet.safeParse({ options: three, divergenceNote: 'n' }).success, true);
  assert.equal(IdeaSet.safeParse({ options: three.slice(0, 2), divergenceNote: 'n' }).success, false, 'two is not three');
  assert.equal(
    IdeaSet.safeParse({
      options: three.map((o) => ({ ...o, whyNot: '' })),
      divergenceNote: 'n',
    }).success,
    false,
    'an option with no argument against it has not been thought about',
  );
});
