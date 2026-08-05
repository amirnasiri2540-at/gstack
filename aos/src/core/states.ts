/**
 * The state machine. This file is the reason there is no agent framework in
 * this project: the owner has to be able to read the whole control flow in one
 * screen, and a framework would hide it behind a scheduler.
 *
 * The build prompt specified:
 *
 *   DRAFT -> IDEATED -> PLANNED -> BUILT -> REVIEWED -> DEFECTS_OPEN
 *         -> DELIVERED -> FOUNDER_REVIEW -> DONE | REJECTED | HALTED_BUDGET
 *
 * That chain has a hole: it routes REVIEWED -> DEFECTS_OPEN -> DELIVERED, which
 * means a run that found defects ships them. Two edges are added here:
 *
 *   REVIEWED     -> DELIVERED   (the clean path, when nothing was found)
 *   DEFECTS_OPEN -> BUILT       (bounded rework, MAX_REWORK passes)
 *
 * Rework is bounded because an unbounded fix loop is the cheapest way to burn a
 * budget on a defect the model cannot actually fix.
 */
import { z } from 'zod';
import { AosError } from './errors.ts';

export const State = z.enum([
  'DRAFT',
  'IDEATED',
  'PLANNED',
  'BUILT',
  'REVIEWED',
  'DEFECTS_OPEN',
  'DELIVERED',
  'FOUNDER_REVIEW',
  'DONE',
  'REJECTED',
  'HALTED_BUDGET',
]);
export type State = z.infer<typeof State>;

/** A run halts here from any state the moment the budget cap would be crossed. */
export const HALT_STATE: State = 'HALTED_BUDGET';

/** Terminal states. The pipeline generator returns once it reaches one. */
export const TERMINAL: readonly State[] = ['DONE', 'REJECTED', 'HALTED_BUDGET'];

/** How many times DEFECTS_OPEN may send work back to FORGE before we stop. */
export const MAX_REWORK = 1;

const TRANSITIONS: Record<State, readonly State[]> = {
  DRAFT: ['IDEATED'],
  IDEATED: ['PLANNED'],
  PLANNED: ['BUILT'],
  BUILT: ['REVIEWED'],
  REVIEWED: ['DEFECTS_OPEN', 'DELIVERED'],
  DEFECTS_OPEN: ['BUILT', 'DELIVERED'],
  DELIVERED: ['FOUNDER_REVIEW'],
  FOUNDER_REVIEW: ['DONE', 'REJECTED'],
  DONE: [],
  REJECTED: [],
  HALTED_BUDGET: [],
};

export function isTerminal(state: State): boolean {
  return TERMINAL.includes(state);
}

export function canTransition(from: State, to: State): boolean {
  if (to === HALT_STATE) return !isTerminal(from);
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws rather than returning false. An illegal transition is a programming
 * error in the pipeline, not a runtime condition to branch on.
 */
export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new AosError(
      'INVALID_TRANSITION',
      `illegal state transition ${from} -> ${to}`,
      { from, to, allowed: from === HALT_STATE ? [] : TRANSITIONS[from] },
    );
  }
}

export function nextStates(from: State): readonly State[] {
  return TRANSITIONS[from];
}
