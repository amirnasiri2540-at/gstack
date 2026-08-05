/**
 * Delivery: the Bill No. 1 gate, and the founder brief.
 *
 * Constraint C8 says the Delivery role throws if the work order contains no
 * runnable artifact. Taken literally that produces a contradiction with the
 * definition of done, which requires FOUNDER_BRIEF.md to exist: a throw would
 * end the run with no brief, so the founder learns nothing about the failure
 * they most need to know about.
 *
 * Resolved by separating the two. The brief is ALWAYS written, on every path,
 * including budget halts and gate failures. The gate then fails the run. A
 * document masquerading as progress is still refused; it just gets refused in
 * writing, where the founder can see it.
 */
import fs from 'node:fs';
import { AosError } from '../core/errors.ts';
import { runnableArtifacts, openDefects } from '../core/schema.ts';
import type { WorkOrder } from '../core/schema.ts';
import type { RunPaths } from '../core/paths.ts';
import type { DeliveryPackage } from '../roles/outputs.ts';
import type { CostReport } from '../report/cost-report.ts';

/** Bill No. 1: a document cannot close a work order. */
export function billNoOneGate(wo: WorkOrder): void {
  const runnable = runnableArtifacts(wo);
  if (runnable.length === 0) {
    throw new AosError(
      'BILL_NO_1',
      `delivery refused: ${wo.artifacts.length} artifact(s), none of them runnable`,
      {
        artifacts: wo.artifacts.map((a) => `${a.path} (${a.kind}, runnable=${a.runnable})`),
        hint: 'A document describing the work is not the work. Send it back to FORGE.',
      },
    );
  }
}

export interface BriefInput {
  wo: WorkOrder;
  paths: RunPaths;
  pkg: DeliveryPackage | null;
  cost: CostReport;
  /** Why the run ended here, in the founder's terms. */
  verdict: string;
  /** What the founder should do next, as a literal instruction. */
  nextStep: string;
}

function bullets(items: string[], empty: string): string {
  return items.length === 0 ? empty : items.map((i) => `- ${i}`).join('\n');
}

/**
 * One page. A founder who was not in the room has about ninety seconds, and a
 * brief they have to scroll is a brief they skim.
 */
export function renderFounderBrief(input: BriefInput): string {
  const { wo, pkg, cost } = input;
  const runnable = runnableArtifacts(wo);
  const open = openDefects(wo);

  const lines: string[] = [
    `# ${pkg?.headline ?? input.verdict}`,
    '',
    `**Idea:** ${wo.idea}`,
    '',
    `**Status:** ${wo.state} · tier ${wo.gate} · $${cost.spentUsd.toFixed(4)} of $${wo.budgetUsd.toFixed(2)} · ${cost.totalCalls} model calls`,
    '',
    input.verdict,
    '',
    '## What shipped',
    '',
    pkg?.whatShipped ?? '_Nothing was packaged; the run ended before delivery._',
    '',
    '## Run it',
    '',
    runnable.length > 0
      ? `\`\`\`\n${pkg?.howToRun ?? `open ${runnable[0]!.path}`}\n\`\`\`\n\nFiles: ${wo.artifacts.map((a) => `\`${a.path}\`${a.runnable ? '' : ' (not runnable)'}`).join(', ')}`
      : '_No runnable artifact was produced._',
    '',
    '## Still open',
    '',
    bullets(
      [...(pkg?.risks ?? []), ...open.map((d) => `${d.severity} defect: ${d.description}`)],
      '- Nothing recorded. On a first delivery that usually means nobody looked hard enough.',
    ),
  ];

  if (pkg && pkg.unverifiedClaims.length > 0) {
    lines.push(
      '',
      '## Unverified claims',
      '',
      'These came from a model tagged as unreliable for factual recall. Check them before acting.',
      '',
      bullets(pkg.unverifiedClaims, ''),
    );
  }

  if (wo.decisions.length > 0) {
    lines.push('', '## Decisions on the record', '');
    for (const d of wo.decisions) {
      lines.push(
        `**${d.title}** — ${d.chosen} (${d.tier}, ${d.reversible ? 'reversible' : 'not reversible'})`,
        '',
        `Falsifier: ${d.falsifier}`,
        '',
        `Reopens on ${d.reviewOn}.`,
        '',
      );
    }
  }

  lines.push(
    '## Cost',
    '',
    '| Role | Calls | Tokens in | Tokens out | Cost |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(cost.byRole).map(
      ([role, c]) =>
        `| ${role} | ${c.calls} | ${c.promptTokens} | ${c.completionTokens} | $${c.costUsd.toFixed(4)} |`,
    ),
    '',
  );
  if (cost.note) lines.push(`> ${cost.note}`, '');

  lines.push('## Your call', '', input.nextStep, '', '---', '', `Run \`${wo.id}\`. Full trace in \`events.jsonl\`.`);
  return lines.join('\n') + '\n';
}

export function writeFounderBrief(input: BriefInput): void {
  fs.writeFileSync(input.paths.brief, renderFounderBrief(input), 'utf-8');
}
