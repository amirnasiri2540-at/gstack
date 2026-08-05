/**
 * Append-only event log. One JSON object per line, never rewritten.
 *
 * Constraint C5 asks that every request and response be written before use. A
 * response obviously cannot be written before it exists, so the enforceable
 * reading is: written before it is *acted on*. router.ts logs model.request
 * before the fetch, and logs model.response the instant bytes arrive, before
 * any parsing, validation or repair touches them. If the process dies during
 * parsing, the log still shows exactly what the model said.
 *
 * The same event type is what the pipeline generator yields (trick #8), so the
 * CLI, a bot adapter, and the log all see one stream with no translation layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Sequencer } from './ids.ts';
import type { State } from './states.ts';
import type { Decision, Defect } from './schema.ts';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type AosEventBody =
  | { type: 'run.started'; runId: string; idea: string; budgetUsd: number; constraints: string[]; transport: string }
  | { type: 'state.changed'; from: State; to: State; note?: string }
  | { type: 'role.started'; role: string; model: string }
  | { type: 'role.finished'; role: string; ok: boolean; ms: number }
  | {
      type: 'model.request';
      role: string;
      model: string;
      hash: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      maxTokens: number;
      estimateUsd: number;
    }
  | {
      type: 'model.response';
      role: string;
      model: string;
      hash: string;
      text: string;
      usage: TokenUsage;
      costUsd: number;
      ms: number;
      source: 'live' | 'cache' | 'replay' | 'mock';
    }
  | { type: 'model.repair'; role: string; model: string; hash: string; issues: string }
  | { type: 'model.error'; role: string; model: string; hash: string; error: string; fatal: boolean }
  | { type: 'budget.halt'; role: string; spentUsd: number; estimateUsd: number; budgetUsd: number }
  | { type: 'artifact.written'; path: string; kind: string; runnable: boolean; producedBy: string; bytes: number }
  | { type: 'decision.made'; decision: Decision }
  | { type: 'defect.filed'; defect: Defect }
  | { type: 'gate.founder'; briefPath: string; gate: string; blocking: boolean }
  | { type: 'run.finished'; state: State; spentUsd: number; ms: number; artifacts: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type AosEvent = AosEventBody & { seq: number; ts: string };
export type AosEventType = AosEventBody['type'];

/**
 * Replay reads model.response events back and must trust their shape, so this
 * one event is strictly validated on read. The rest are produced only by this
 * codebase and are validated structurally.
 */
export const ModelResponseEvent = z.object({
  seq: z.number().int(),
  ts: z.string(),
  type: z.literal('model.response'),
  role: z.string(),
  model: z.string(),
  hash: z.string(),
  text: z.string(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }),
  costUsd: z.number(),
  ms: z.number(),
  source: z.enum(['live', 'cache', 'replay', 'mock']),
});

export class EventLog {
  #file: string;
  #seq = 0;
  #clock: Sequencer;
  #listeners: Array<(e: AosEvent) => void> = [];

  constructor(file: string, clock: Sequencer) {
    this.#file = file;
    this.#clock = clock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Opening in append mode is the whole durability story. Nothing truncates.
    fs.appendFileSync(file, '');
  }

  get file(): string {
    return this.#file;
  }

  get seq(): number {
    return this.#seq;
  }

  onAppend(fn: (e: AosEvent) => void): void {
    this.#listeners.push(fn);
  }

  append(body: AosEventBody): AosEvent {
    const event = { seq: ++this.#seq, ts: this.#clock.now(), ...body } as AosEvent;
    fs.appendFileSync(this.#file, JSON.stringify(event) + '\n', 'utf-8');
    for (const fn of this.#listeners) fn(event);
    return event;
  }
}

export function readEvents(file: string): AosEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as AosEvent;
      } catch (err) {
        throw new Error(`events.jsonl line ${i + 1} is not valid JSON: ${(err as Error).message}`);
      }
    });
}

export function eventsOfType<T extends AosEventType>(
  events: AosEvent[],
  type: T,
): Array<Extract<AosEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<Extract<AosEvent, { type: T }>>;
}
