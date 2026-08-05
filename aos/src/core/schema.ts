/**
 * The WorkOrder is the only thing that moves between roles.
 *
 * There is no shared memory, no vector store, no chat history. State lives in
 * this object; the audit trail lives in events.jsonl. A role receives a
 * WorkOrder and returns a WorkOrder. That is the entire contract.
 */
import { z } from 'zod';
import { State } from './states.ts';

export const Tier = z.enum(['GREEN', 'YELLOW', 'RED']);
export type Tier = z.infer<typeof Tier>;

export const Artifact = z.object({
  path: z.string(),
  kind: z.enum(['code', 'doc', 'config', 'test', 'screenshot']),
  /** Bill No. 1 gate reads this. A doc with runnable:false cannot close a run. */
  runnable: z.boolean(),
  producedBy: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

export const Decision = z.object({
  id: z.string(),
  title: z.string(),
  chosen: z.string(),
  alternatives: z.array(z.string()),
  assumptions: z.array(z.string()),
  /** The single fact that would prove this decision wrong. */
  falsifier: z.string(),
  /** ISO date. AOS reopens the decision automatically once this passes. */
  reviewOn: z.string(),
  tier: Tier,
  /** Gate for autonomy, not a task category. Reversible work needs no founder. */
  reversible: z.boolean(),
  status: z.enum(['ACTIVE', 'REOPENED', 'SUPERSEDED']),
});
export type Decision = z.infer<typeof Decision>;

export const Defect = z.object({
  id: z.string(),
  severity: z.enum(['S1', 'S2', 'S3']),
  description: z.string(),
  foundBy: z.string(),
  status: z.enum(['OPEN', 'FIXED', 'WONTFIX']),
  /** Must be reproducible, not an opinion. SENTINEL refuses to file without it. */
  evidence: z.string(),
});
export type Defect = z.infer<typeof Defect>;

export const WorkOrder = z.object({
  id: z.string(),
  createdAt: z.string(),
  /**
   * Deviation from the build prompt, which specified z.string(). A typo'd state
   * would otherwise pass validation and route the machine nowhere. The enum
   * turns that class of bug into a load-time failure.
   */
  state: State,
  idea: z.string(),
  constraints: z.array(z.string()),
  budgetUsd: z.number(),
  spentUsd: z.number(),
  gate: Tier,
  artifacts: z.array(Artifact),
  decisions: z.array(Decision),
  defects: z.array(Defect),
  /**
   * Bounded rework counter. The build prompt's state chain had no way back from
   * DEFECTS_OPEN, which would ship known-broken work. See states.ts.
   */
  reworkCount: z.number().int().min(0).default(0),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

export function newWorkOrder(input: {
  id: string;
  createdAt: string;
  idea: string;
  constraints?: string[];
  budgetUsd: number;
  gate?: Tier;
}): WorkOrder {
  return WorkOrder.parse({
    id: input.id,
    createdAt: input.createdAt,
    state: 'DRAFT',
    idea: input.idea,
    constraints: input.constraints ?? [],
    budgetUsd: input.budgetUsd,
    spentUsd: 0,
    gate: input.gate ?? 'GREEN',
    artifacts: [],
    decisions: [],
    defects: [],
    reworkCount: 0,
  });
}

export function openDefects(wo: WorkOrder): Defect[] {
  return wo.defects.filter((d) => d.status === 'OPEN');
}

export function blockingDefects(wo: WorkOrder): Defect[] {
  return openDefects(wo).filter((d) => d.severity === 'S1');
}

export function runnableArtifacts(wo: WorkOrder): Artifact[] {
  return wo.artifacts.filter((a) => a.runnable);
}
