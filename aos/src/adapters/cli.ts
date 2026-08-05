#!/usr/bin/env node
/**
 * The CLI adapter.
 *
 *   npm run aos -- "build a single-page tip calculator"
 *   npm run aos -- "..." --budget 2.00 --constraint "no dependencies"
 *
 * This file renders events. It contains no orchestration, which is the test of
 * whether trick #8 actually paid off: a Telegram or web adapter is this file
 * with a different render function, not a second copy of the pipeline.
 */
import 'dotenv/config';
import { buildRuntime } from '../core/runtime.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { AosEvent } from '../core/events.ts';
import { isAosError } from '../core/errors.ts';

interface Args {
  idea: string;
  budgetUsd: number;
  constraints: string[];
  cache: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { idea: '', budgetUsd: 1.0, constraints: [], cache: true };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--budget') args.budgetUsd = Number.parseFloat(argv[++i] ?? '');
    else if (a === '--constraint') args.constraints.push(argv[++i] ?? '');
    else if (a === '--no-cache') args.cache = false;
    else if (a === '--help' || a === '-h') {
      console.log('usage: npm run aos -- "<idea>" [--budget <usd>] [--constraint <text>] [--no-cache]');
      process.exit(0);
    } else positional.push(a);
  }
  args.idea = positional.join(' ').trim();
  if (!args.idea) {
    console.error('usage: npm run aos -- "<idea>"');
    process.exit(2);
  }
  if (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0) {
    console.error('--budget must be a positive number of dollars');
    process.exit(2);
  }
  return args;
}

const money = (n: number): string => `$${n.toFixed(4)}`;

function render(e: AosEvent): string | null {
  switch (e.type) {
    case 'run.started':
      return `\n  ${e.runId}\n  ${e.idea}\n  budget ${money(e.budgetUsd)} · transport ${e.transport}\n`;
    case 'role.started':
      return `  ${e.role.padEnd(9)} ${e.model}`;
    case 'role.finished':
      return `  ${''.padEnd(9)} done in ${(e.ms / 1000).toFixed(1)}s`;
    case 'model.response':
      return `  ${''.padEnd(9)}   ${e.source === 'cache' ? 'cached' : money(e.costUsd)} · ${e.usage.promptTokens}in/${e.usage.completionTokens}out`;
    case 'model.repair':
      return `  ${''.padEnd(9)}   repair: ${e.issues.split('\n')[0]}`;
    case 'state.changed':
      return `  -> ${e.to}${e.note ? ` (${e.note})` : ''}`;
    case 'artifact.written':
      return `  ${''.padEnd(9)}   wrote ${e.path} (${e.bytes} bytes${e.runnable ? ', runnable' : ''})`;
    case 'defect.filed':
      return `  ${''.padEnd(9)}   ${e.defect.severity} ${e.defect.description}`;
    case 'budget.halt':
      return `\n  BUDGET CAP: spent ${money(e.spentUsd)}, next call needs ${money(e.estimateUsd)}, cap ${money(e.budgetUsd)}`;
    case 'gate.founder':
      return `\n  brief: ${e.briefPath}`;
    case 'run.finished':
      return `\n  ${e.state} · ${money(e.spentUsd)} · ${(e.ms / 1000).toFixed(1)}s · ${e.artifacts} artifact(s)`;
    case 'log':
      return `  ! ${e.message}`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rt = buildRuntime({
    idea: args.idea,
    budgetUsd: args.budgetUsd,
    constraints: args.constraints,
    cache: args.cache,
  });

  for await (const event of runPipeline(rt)) {
    const line = render(event);
    if (line !== null) console.log(line);
  }

  console.log(`\n  cost:  ${rt.paths.cost}`);
  console.log(`  brief: ${rt.paths.brief}`);
  console.log(`  trace: ${rt.paths.events}\n`);
}

main().catch((err: unknown) => {
  if (isAosError(err)) {
    console.error(`\n  failed [${err.code}]: ${err.message}`);
    const hint = err.detail.hint;
    if (typeof hint === 'string') console.error(`  ${hint}`);
  } else {
    console.error(`\n  failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  process.exit(1);
});
