/**
 * cost.json, derived entirely from events.jsonl.
 *
 * Nothing accumulates cost in memory and writes it out at the end, because then
 * a crash loses the accounting for the run that most needs accounting. The
 * append-only log is the single source of truth; this is a projection of it,
 * and it can be regenerated for any past run at any time.
 */
import fs from 'node:fs';
import { readEvents, eventsOfType } from '../core/events.ts';
import type { AosEvent } from '../core/events.ts';

export interface RoleCost {
  calls: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMsTotal: number;
  models: string[];
}

export interface CostReport {
  runId: string;
  generatedAt: string;
  transport: string;
  budgetUsd: number;
  spentUsd: number;
  totalCalls: number;
  cacheHits: number;
  byRole: Record<string, RoleCost>;
  byModel: Record<string, RoleCost>;
  /** Present only when the numbers are not real money. */
  note?: string;
}

function blank(): RoleCost {
  return { calls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMsTotal: 0, models: [] };
}

function add(bucket: Record<string, RoleCost>, key: string, e: Extract<AosEvent, { type: 'model.response' }>): void {
  const b = (bucket[key] ??= blank());
  b.calls++;
  if (e.source === 'cache') b.cacheHits++;
  b.promptTokens += e.usage.promptTokens;
  b.completionTokens += e.usage.completionTokens;
  b.costUsd = round(b.costUsd + e.costUsd);
  b.latencyMsTotal += e.ms;
  if (!b.models.includes(e.model)) b.models.push(e.model);
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function buildCostReport(eventsFile: string, runId: string, budgetUsd: number): CostReport {
  const events = readEvents(eventsFile);
  const responses = eventsOfType(events, 'model.response');
  const started = eventsOfType(events, 'run.started')[0];

  const byRole: Record<string, RoleCost> = {};
  const byModel: Record<string, RoleCost> = {};
  for (const e of responses) {
    add(byRole, e.role, e);
    add(byModel, e.model, e);
  }

  const transport = started?.transport ?? 'unknown';
  const report: CostReport = {
    runId,
    generatedAt: new Date().toISOString(),
    transport,
    budgetUsd,
    spentUsd: round(responses.reduce((s, e) => s + e.costUsd, 0)),
    totalCalls: responses.length,
    cacheHits: responses.filter((e) => e.source === 'cache').length,
    byRole,
    byModel,
  };

  if (transport === 'mock') {
    report.note =
      'These figures are simulated. The run used offline stubs, not models, so no money was spent and the token counts are estimates over stub text.';
  }
  return report;
}

export function writeCostReport(file: string, report: CostReport): void {
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf-8');
}
