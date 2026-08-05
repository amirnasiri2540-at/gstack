#!/usr/bin/env node
/**
 * npm run replay <runId>
 *
 * Trick #11. Re-runs the pipeline against a previous run's recorded responses,
 * with zero API calls, so pipeline logic can be debugged for free as many times
 * as it takes.
 *
 * A replay that hits a call the original run never made fails with REPLAY_MISS
 * rather than quietly going to the network. That failure is informative: it
 * means your change altered a prompt, so the recording no longer covers the
 * path you are on.
 */
import fs from 'node:fs';
import 'dotenv/config';

import { FILES } from '../core/project.ts';
import { runPaths } from '../core/paths.ts';
import { buildRuntime } from '../core/runtime.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import { readEvents, eventsOfType } from '../core/events.ts';
import { deterministicSequencer } from '../core/ids.ts';
import { WorkOrder } from '../core/schema.ts';
import { AosError, isAosError } from '../core/errors.ts';

function main2(): Promise<void> {
  const runId = process.argv[2];
  if (!runId || runId === '--help' || runId === '-h') {
    console.log('usage: npm run replay <runId>');
    process.exit(runId ? 0 : 2);
  }

  const original = runPaths(FILES.runsDir, runId);
  if (!fs.existsSync(original.events)) {
    throw new AosError('REPLAY_MISS', `no event log at ${original.events}`, {
      hint: fs.existsSync(FILES.runsDir) ? `Available: ${fs.readdirSync(FILES.runsDir).slice(-5).join(', ')}` : undefined,
    });
  }

  const events = readEvents(original.events);
  const started = eventsOfType(events, 'run.started')[0];
  if (!started) throw new AosError('REPLAY_MISS', `${original.events} has no run.started event`, {});

  const wo = fs.existsSync(original.workorder)
    ? WorkOrder.parse(JSON.parse(fs.readFileSync(original.workorder, 'utf-8')))
    : null;

  console.log(`\n  replaying ${runId}`);
  console.log(`  ${started.idea}`);
  console.log(`  ${eventsOfType(events, 'model.response').length} recorded responses, 0 API calls\n`);

  // A deterministic sequencer seeded from the original run means ids and
  // timestamps come out identical, so the two work orders can be diffed
  // directly. That is the whole point of injecting time and identity.
  const rt = buildRuntime({
    idea: started.idea,
    budgetUsd: started.budgetUsd,
    constraints: started.constraints,
    cache: false,
    replayFrom: original.events,
    runId: `${runId}-replay`,
    seq: deterministicSequencer(wo?.createdAt ?? started.ts),
  });

  return (async () => {
    for await (const e of runPipeline(rt)) {
      if (e.type === 'state.changed') console.log(`  -> ${e.to}${e.note ? ` (${e.note})` : ''}`);
      if (e.type === 'run.finished') console.log(`\n  ${e.state} · ${e.artifacts} artifact(s) · $0.0000 spent`);
    }
    console.log(`\n  output: ${rt.paths.runDir}`);
    if (wo) {
      const replayed = WorkOrder.parse(JSON.parse(fs.readFileSync(rt.paths.workorder, 'utf-8')));
      const same = replayed.state === wo.state && replayed.artifacts.length === wo.artifacts.length;
      console.log(`  matches original: ${same ? 'yes' : 'NO — the pipeline logic changed'}\n`);
    }
  })();
}

main2().catch((err: unknown) => {
  if (isAosError(err)) {
    console.error(`\n  failed [${err.code}]: ${err.message}`);
    const hint = err.detail.hint;
    if (typeof hint === 'string') console.error(`  ${hint}`);
  } else {
    console.error(`\n  failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  process.exit(1);
});
