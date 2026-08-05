#!/usr/bin/env node
/**
 * npm run aos:resume <runId> -- --approve
 * npm run aos:resume <runId> -- --reject "the reason"
 *
 * The other half of trick #9. Because the founder gate is a state rather than a
 * prompt on a blocked stdin, the verdict can arrive from a different process,
 * a different terminal, or a different day, and the run picks up exactly where
 * it stopped.
 *
 * The verdict is appended to the same events.jsonl with the sequence continuing
 * unbroken, and recorded in verdict.json. That file is the input the scoreboard
 * (feature 6.2) will aggregate: accept/edit/reject per role per model is the
 * only honest way to answer "which model for which role" for your workload.
 */
import fs from 'node:fs';
import 'dotenv/config';

import { FILES } from '../core/project.ts';
import { runPaths } from '../core/paths.ts';
import { WorkOrder } from '../core/schema.ts';
import { assertTransition } from '../core/states.ts';
import { EventLog, readEvents, eventsOfType } from '../core/events.ts';
import { liveSequencer } from '../core/ids.ts';
import { buildCostReport, writeCostReport } from '../report/cost-report.ts';
import { renderFounderBrief } from '../pipeline/herald.ts';
import { AosError, isAosError } from '../core/errors.ts';

interface Args {
  runId: string;
  approve: boolean;
  reason: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runId: '', approve: false, reason: '' };
  const positional: string[] = [];
  let sawVerdict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--approve') {
      args.approve = true;
      sawVerdict = true;
    } else if (a === '--reject') {
      args.approve = false;
      sawVerdict = true;
      args.reason = argv[++i] ?? '';
    } else if (a === '--help' || a === '-h') {
      console.log('usage: npm run aos:resume <runId> -- --approve | --reject "reason"');
      process.exit(0);
    } else positional.push(a);
  }
  args.runId = positional[0] ?? '';
  if (!args.runId || !sawVerdict) {
    console.error('usage: npm run aos:resume <runId> -- --approve | --reject "reason"');
    process.exit(2);
  }
  if (!args.approve && args.reason.trim().length === 0) {
    console.error('a rejection needs a reason. The reason is the only part of it anyone will read later.');
    process.exit(2);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const paths = runPaths(FILES.runsDir, args.runId);

  if (!fs.existsSync(paths.workorder)) {
    throw new AosError('ROLE_CONFIG', `no run at ${paths.runDir}`, {
      hint: `Available: ${fs.existsSync(FILES.runsDir) ? fs.readdirSync(FILES.runsDir).slice(-5).join(', ') : 'none'}`,
    });
  }

  let wo = WorkOrder.parse(JSON.parse(fs.readFileSync(paths.workorder, 'utf-8')));
  if (wo.state !== 'FOUNDER_REVIEW') {
    throw new AosError('INVALID_TRANSITION', `run ${args.runId} is ${wo.state}, not waiting on a verdict`, {
      state: wo.state,
      hint: wo.state === 'DONE' || wo.state === 'REJECTED' ? 'This run already has a verdict.' : undefined,
    });
  }

  const to = args.approve ? 'DONE' : 'REJECTED';
  assertTransition(wo.state, to);

  // Continues the run's sequence rather than restarting it. Still append-only.
  const log = EventLog.continue(paths.events, liveSequencer());
  log.append({ type: 'state.changed', from: wo.state, to, note: args.approve ? 'founder approved' : args.reason });
  wo = WorkOrder.parse({ ...wo, state: to });

  const cost = buildCostReport(paths.events, wo.id, wo.budgetUsd);
  writeCostReport(paths.cost, cost);
  wo = WorkOrder.parse({ ...wo, spentUsd: cost.spentUsd });
  fs.writeFileSync(paths.workorder, JSON.stringify(wo, null, 2) + '\n', 'utf-8');

  // One line per role per model. This is what makes routing empirical later.
  const events = readEvents(paths.events);
  const verdictLines = Object.entries(cost.byRole).map(([role, c]) => ({
    ts: new Date().toISOString(),
    runId: wo.id,
    role,
    model: c.models.join('+'),
    verdict: args.approve ? 'accepted' : 'rejected',
    costUsd: c.costUsd,
    latencyMs: c.latencyMsTotal,
  }));
  fs.writeFileSync(paths.verdict, verdictLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

  const pkgless = eventsOfType(events, 'gate.founder').at(-1);
  fs.writeFileSync(
    paths.brief,
    renderFounderBrief({
      wo,
      paths,
      pkg: null,
      cost,
      verdict: args.approve
        ? '**Approved by the founder.**'
        : `**Rejected by the founder.** ${args.reason}`,
      nextStep: args.approve
        ? `Open ${wo.artifacts.find((a) => a.runnable)?.path ?? 'the artifacts directory'}.`
        : 'Re-run with the reason folded into the idea or the constraints.',
    }).replace('# ', `# ${args.approve ? 'Approved' : 'Rejected'}: `),
    'utf-8',
  );

  log.append({
    type: 'run.finished',
    state: wo.state,
    spentUsd: cost.spentUsd,
    ms: 0,
    artifacts: wo.artifacts.length,
  });

  console.log(`\n  ${wo.id} -> ${to}`);
  if (!args.approve) console.log(`  reason: ${args.reason}`);
  console.log(`  verdict: ${paths.verdict}`);
  console.log(`  brief:   ${paths.brief}`);
  console.log(`  gate was ${pkgless?.gate ?? wo.gate}\n`);
}

try {
  main();
} catch (err) {
  if (isAosError(err)) {
    console.error(`\n  failed [${err.code}]: ${err.message}`);
    const hint = err.detail.hint;
    if (typeof hint === 'string') console.error(`  ${hint}`);
  } else {
    console.error(`\n  failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  process.exit(1);
}
