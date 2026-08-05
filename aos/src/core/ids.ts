/**
 * Time and identity are injected, never read from the ambient environment
 * inside pipeline code.
 *
 * This is what makes replay (trick #11) worth anything. If the pipeline called
 * Date.now() or randomUUID() directly, a replay would produce a WorkOrder with
 * different ids and timestamps than the original, and you could not diff the
 * two to prove the logic is unchanged. With an injected sequencer, replaying a
 * run reproduces it byte for byte.
 */
import { randomBytes } from 'node:crypto';

export interface Sequencer {
  /** ISO timestamp for the next event. */
  now(): string;
  /** Stable, prefixed identifier, e.g. "dec_004". */
  id(prefix: string): string;
}

export function liveSequencer(): Sequencer {
  let counter = 0;
  return {
    now: () => new Date().toISOString(),
    id: (prefix: string) => `${prefix}_${String(++counter).padStart(3, '0')}`,
  };
}

/**
 * Deterministic sequencer used by replay and by tests. Timestamps advance by a
 * fixed step so ordering survives while values stay reproducible.
 */
export function deterministicSequencer(startIso: string, stepMs = 1000): Sequencer {
  const base = Date.parse(startIso);
  if (Number.isNaN(base)) throw new TypeError(`invalid start timestamp: ${startIso}`);
  let ticks = 0;
  let counter = 0;
  return {
    now: () => new Date(base + stepMs * ticks++).toISOString(),
    id: (prefix: string) => `${prefix}_${String(++counter).padStart(3, '0')}`,
  };
}

/** Run ids are sortable by creation time, which makes `ls runs/` useful. */
export function newRunId(at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}
