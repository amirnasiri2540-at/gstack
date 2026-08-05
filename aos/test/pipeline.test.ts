/**
 * End-to-end pipeline behaviour.
 *
 * The happy path is the least interesting test here. What matters is that every
 * abnormal exit still produces the four things the founder was promised: a
 * brief, a cost report, a work order and a complete event log. A run that fails
 * silently is worse than one that fails, and the failing runs are the ones
 * somebody actually needs to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPipeline } from '../src/pipeline/pipeline.ts';
import type { PipelineDeps } from '../src/pipeline/pipeline.ts';
import { EventLog, readEvents, eventsOfType } from '../src/core/events.ts';
import type { AosEvent } from '../src/core/events.ts';
import { deterministicSequencer } from '../src/core/ids.ts';
import { runPaths, ensureRunDirs } from '../src/core/paths.ts';
import { BudgetMeter } from '../src/core/cost.ts';
import { ResponseCache } from '../src/core/cache.ts';
import { mockCatalog } from '../src/core/catalog.ts';
import { mockTransport } from '../src/core/transport.ts';
import type { TransportRequest } from '../src/core/transport.ts';
import { offlineResponder } from '../src/core/offline-responder.ts';
import { newWorkOrder } from '../src/core/schema.ts';
import { loadRoles } from '../src/core/roles.ts';
import { RoutingLock } from '../src/core/routing.ts';
import { FILES } from '../src/core/project.ts';
import { AosError } from '../src/core/errors.ts';

const LOCK = RoutingLock.parse({
  version: 1,
  catalog: { source: 'mock', fetchedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.invalid/v1' },
  roles: {
    MUSE: { model: 'google/offline-stub-cheap', fallback: 'openai/offline-stub-cheap', parallel: [] },
    ATLAS: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    FORGE: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    ECHO: {
      model: 'google/offline-stub-mid',
      fallback: 'openai/offline-stub-mid',
      parallel: ['openai/offline-stub-mid'],
    },
    SENTINEL: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    HERALD: { model: 'google/offline-stub-cheap', fallback: 'openai/offline-stub-cheap', parallel: [] },
  },
});

const IDEA = 'build a single-page tip calculator';

interface Harness {
  dir: string;
  deps: PipelineDeps;
  events: () => AosEvent[];
}

function harness(opts: { budgetUsd?: number; override?: (req: TransportRequest) => string | null } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-pipeline-'));
  const seq = deterministicSequencer('2026-01-01T00:00:00.000Z');
  const paths = runPaths(path.join(dir, 'runs'), 'run_test');
  ensureRunDirs(paths);

  const canned = offlineResponder(IDEA);
  const transport = mockTransport((req) => opts.override?.(req) ?? canned(req));

  const log = new EventLog(paths.events, seq);
  const deps: PipelineDeps = {
    wo: newWorkOrder({ id: 'run_test', createdAt: '2026-01-01T00:00:00.000Z', idea: IDEA, budgetUsd: opts.budgetUsd ?? 1 }),
    paths,
    roles: loadRoles(FILES.rolesDir, LOCK),
    ctx: {
      log,
      budget: new BudgetMeter(opts.budgetUsd ?? 1),
      cache: new ResponseCache(path.join(dir, '.cache'), false),
      catalog: mockCatalog('https://example.invalid/v1', '2026-01-01T00:00:00.000Z'),
      transport,
    },
    seq,
  };
  return { dir, deps, events: () => readEvents(paths.events) };
}

async function drive(h: Harness): Promise<{ yielded: AosEvent[]; error: unknown }> {
  const yielded: AosEvent[] = [];
  try {
    for await (const e of runPipeline(h.deps)) yielded.push(e);
    return { yielded, error: null };
  } catch (err) {
    return { yielded, error: err };
  }
}

test('a full run produces all four promised artifacts and reaches DONE', async () => {
  const h = harness();
  const { error } = await drive(h);
  assert.equal(error, null);

  const p = h.deps.paths;
  assert.ok(fs.existsSync(path.join(p.artifactsDir, 'index.html')), 'runnable artifact');
  assert.ok(fs.existsSync(p.brief), 'FOUNDER_BRIEF.md');
  assert.ok(fs.existsSync(p.cost), 'cost.json');
  assert.ok(fs.existsSync(p.events), 'events.jsonl');
  assert.ok(fs.existsSync(p.workorder), 'workorder.json');

  const wo = JSON.parse(fs.readFileSync(p.workorder, 'utf-8'));
  assert.equal(wo.state, 'DONE');

  // The brief reports where the run ended, not where it passed through.
  assert.match(fs.readFileSync(p.brief, 'utf-8'), /\*\*Status:\*\* DONE/);

  const cost = JSON.parse(fs.readFileSync(p.cost, 'utf-8'));
  assert.equal(cost.transport, 'mock');
  assert.ok(cost.note, 'a simulated run says so in its own cost report');
  assert.deepEqual(Object.keys(cost.byRole).sort(), ['ATLAS', 'ECHO', 'FORGE', 'HERALD', 'MUSE', 'SENTINEL']);
  assert.equal(cost.byRole.MUSE.calls, 3, 'three divergent options, three independent calls');
  assert.equal(cost.byRole.ECHO.calls, 2, 'two critics on two providers');
  assert.equal(cost.byRole.ECHO.models.length, 2);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('every logged event is also yielded to the adapter', async () => {
  const h = harness();
  const { yielded } = await drive(h);
  const logged = h.events();
  assert.deepEqual(
    yielded.map((e) => e.seq),
    logged.map((e) => e.seq),
    'an event that reaches disk but not the UI is an event nobody sees',
  );
  assert.ok(logged.length > 20);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a doc-only handoff is refused, and the refusal is written down', async () => {
  const h = harness({
    override: (req) =>
      req.role === 'FORGE'
        ? JSON.stringify({
            files: [
              {
                path: 'PLAN.md',
                kind: 'doc',
                runnable: false,
                contents: '# Tip calculator\n\nHere is how I would build it.',
              },
            ],
            notes: 'A document describing the work.',
          })
        : null,
  });

  const { error } = await drive(h);
  assert.ok(error instanceof AosError && error.code === 'BILL_NO_1', 'Bill No. 1 must stop this');

  // The gate fails the run, but the founder still gets told why in writing.
  const brief = fs.readFileSync(h.deps.paths.brief, 'utf-8');
  assert.match(brief, /Delivery refused/);
  assert.match(brief, /not the work/);
  assert.match(brief, /\*\*Status:\*\* REJECTED/);
  assert.ok(fs.existsSync(h.deps.paths.cost), 'cost.json is written even on refusal');

  const wo = JSON.parse(fs.readFileSync(h.deps.paths.workorder, 'utf-8'));
  assert.equal(wo.state, 'REJECTED');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a budget cap stops the run and still leaves a brief behind', async () => {
  // Enough for MUSE's three calls, nowhere near enough for the whole pipeline.
  const h = harness({ budgetUsd: 0.002 });
  const { error } = await drive(h);

  assert.ok(error instanceof AosError && error.code === 'BUDGET_EXCEEDED');
  assert.equal(eventsOfType(h.events(), 'budget.halt').length, 1);

  const wo = JSON.parse(fs.readFileSync(h.deps.paths.workorder, 'utf-8'));
  assert.equal(wo.state, 'HALTED_BUDGET');
  assert.ok(wo.spentUsd <= 0.002, `spent ${wo.spentUsd} must not exceed the cap`);

  const brief = fs.readFileSync(h.deps.paths.brief, 'utf-8');
  assert.match(brief, /budget cap/i);
  assert.match(brief, /--budget/, 'the brief says how to raise it');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('an artifact path that escapes the sandbox costs that file, not the run', async () => {
  const h = harness({
    override: (req) =>
      req.role === 'FORGE'
        ? JSON.stringify({
            files: [
              { path: '../../../etc/cron.d/pwned', kind: 'code', runnable: true, contents: 'evil' },
              { path: 'index.html', kind: 'code', runnable: true, contents: '<!doctype html><title>ok</title>' },
            ],
            notes: '',
          })
        : null,
  });

  const { error } = await drive(h);
  assert.equal(error, null, 'one refused path should not kill a run that produced a good file');

  assert.equal(fs.existsSync('/etc/cron.d/pwned'), false);
  assert.deepEqual(fs.readdirSync(h.deps.paths.artifactsDir), ['index.html']);

  const warnings = h.events().filter((e) => e.type === 'log' && e.level === 'warn');
  assert.equal(warnings.length, 1, 'the refusal is on the record');
  assert.match((warnings[0] as { message: string }).message, /parent traversal/);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('an S1 defect sends the work back to FORGE exactly once', async () => {
  let sentinelCalls = 0;
  const h = harness({
    override: (req) => {
      if (req.role !== 'SENTINEL') return null;
      sentinelCalls++;
      // Report the same blocking defect every time. The loop must still stop.
      return JSON.stringify({
        defects: [
          {
            severity: 'S1',
            description: 'The artifact does not compute a tip at all',
            evidence: 'Open index.html, enter 100 and 20, and no tip value is ever displayed anywhere on the page.',
          },
        ],
        testsRun: ['opened the artifact and looked for a tip field'],
      });
    },
  });

  const { error } = await drive(h);
  assert.equal(error, null);

  const events = h.events();
  const states = eventsOfType(events, 'state.changed').map((e) => e.to);
  assert.deepEqual(states, [
    'IDEATED',
    'PLANNED',
    'BUILT',
    'REVIEWED',
    'DEFECTS_OPEN',
    'BUILT',
    'REVIEWED',
    'DEFECTS_OPEN',
    'DELIVERED',
    'FOUNDER_REVIEW',
  ]);
  assert.equal(sentinelCalls, 2, 'one rework pass, then ship with the defect on the record');

  // Unresolved S1 means the founder decides, not the machine.
  const wo = JSON.parse(fs.readFileSync(h.deps.paths.workorder, 'utf-8'));
  assert.equal(wo.state, 'FOUNDER_REVIEW');
  const brief = fs.readFileSync(h.deps.paths.brief, 'utf-8');
  assert.match(brief, /blocking defect/);
  assert.match(brief, /aos:resume/);
  fs.rmSync(h.dir, { recursive: true, force: true });
});
