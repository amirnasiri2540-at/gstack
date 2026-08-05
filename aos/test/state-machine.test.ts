/**
 * Commit 1 proof: the state machine and the event log work with no model at all.
 *
 * echoRole is a fake role. It takes a WorkOrder, does something trivially
 * verifiable, and returns a WorkOrder. If the machine can be driven from DRAFT
 * to DONE by this fake, then commit 4 only has to swap the fake for callModel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { newWorkOrder, WorkOrder } from '../src/core/schema.ts';
import type { WorkOrder as WO } from '../src/core/schema.ts';
import { assertTransition, canTransition, isTerminal, MAX_REWORK, nextStates } from '../src/core/states.ts';
import type { State } from '../src/core/states.ts';
import { EventLog, readEvents, eventsOfType } from '../src/core/events.ts';
import { deterministicSequencer } from '../src/core/ids.ts';
import { runPaths, ensureRunDirs } from '../src/core/paths.ts';
import { AosError } from '../src/core/errors.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-'));
}

/** The fake. No network, no model, no cost. */
function echoRole(name: string, to: State, mutate: (wo: WO) => WO) {
  return (wo: WO): WO => {
    assertTransition(wo.state, to);
    return WorkOrder.parse({ ...mutate(wo), state: to });
  };
}

test('happy path: DRAFT to DONE with no model calls', () => {
  const root = tmpRoot();
  const clock = deterministicSequencer('2026-01-01T00:00:00.000Z');
  const paths = runPaths(path.join(root, 'runs'), 'run_test');
  ensureRunDirs(paths);
  const log = new EventLog(paths.events, clock);

  let wo = newWorkOrder({ id: 'run_test', createdAt: clock.now(), idea: 'tip calculator', budgetUsd: 1 });
  log.append({ type: 'run.started', runId: wo.id, idea: wo.idea, budgetUsd: 1, constraints: [], transport: 'none' });

  const steps: Array<[string, State, (w: WO) => WO]> = [
    ['MUSE', 'IDEATED', (w) => w],
    ['ATLAS', 'PLANNED', (w) => w],
    ['FORGE', 'BUILT', (w) => ({
      ...w,
      artifacts: [{ path: 'artifacts/index.html', kind: 'code', runnable: true, producedBy: 'FORGE' }],
    })],
    ['ECHO', 'REVIEWED', (w) => w],
    ['SENTINEL', 'DELIVERED', (w) => w],
    ['HERALD', 'FOUNDER_REVIEW', (w) => w],
    ['AMIR', 'DONE', (w) => w],
  ];

  for (const [role, to, mutate] of steps) {
    const from = wo.state;
    wo = echoRole(role, to, mutate)(wo);
    log.append({ type: 'state.changed', from, to });
  }

  assert.equal(wo.state, 'DONE');
  assert.ok(isTerminal(wo.state));
  assert.equal(wo.artifacts.length, 1);

  const events = readEvents(paths.events);
  assert.equal(events.length, 8);
  assert.equal(eventsOfType(events, 'state.changed').length, 7);
  // Sequence numbers are dense and monotonic; that is what makes replay ordered.
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('rework loop: DEFECTS_OPEN returns to BUILT, bounded', () => {
  assert.ok(canTransition('REVIEWED', 'DEFECTS_OPEN'));
  assert.ok(canTransition('DEFECTS_OPEN', 'BUILT'), 'defects must be fixable, not just recorded');
  assert.ok(canTransition('DEFECTS_OPEN', 'DELIVERED'));
  assert.equal(MAX_REWORK, 1, 'an unbounded fix loop is the cheapest way to burn a budget');
});

test('illegal transitions throw rather than returning false', () => {
  assert.throws(
    () => assertTransition('DRAFT', 'DONE'),
    (err: unknown) => err instanceof AosError && err.code === 'INVALID_TRANSITION',
  );
  assert.equal(canTransition('DRAFT', 'BUILT'), false);
  assert.deepEqual(nextStates('DONE'), []);
});

test('budget halt is reachable from any non-terminal state', () => {
  const live: State[] = ['DRAFT', 'IDEATED', 'PLANNED', 'BUILT', 'REVIEWED', 'DEFECTS_OPEN', 'DELIVERED', 'FOUNDER_REVIEW'];
  for (const s of live) assert.ok(canTransition(s, 'HALTED_BUDGET'), `${s} must be able to halt`);
  for (const s of ['DONE', 'REJECTED', 'HALTED_BUDGET'] as State[]) {
    assert.equal(canTransition(s, 'HALTED_BUDGET'), false, `${s} is terminal`);
  }
});

test('a typo in a state name fails validation instead of routing nowhere', () => {
  const wo = newWorkOrder({ id: 'x', createdAt: '2026-01-01T00:00:00.000Z', idea: 'i', budgetUsd: 1 });
  assert.throws(() => WorkOrder.parse({ ...wo, state: 'DELIVRED' }));
});
