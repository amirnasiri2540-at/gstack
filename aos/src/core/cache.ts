/**
 * Content-hash cache (trick #4).
 *
 * During development you will run the same pipeline forty times. Pay once. The
 * key covers everything that changes an answer: model, temperature, max tokens,
 * and the exact message array. It deliberately does NOT cover the role name, so
 * two roles issuing an identical call share a hit.
 *
 * A cache hit costs zero, so it is checked before the budget pre-flight. That
 * ordering matters: a cached run should never be able to halt on budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TokenUsage } from './events.ts';

export interface CachedResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  storedAt: string;
}

export function hashCall(input: {
  model: string;
  temperature: number;
  maxTokens: number;
  messages: Array<{ role: string; content: string }>;
}): string {
  const canonical = JSON.stringify([input.model, input.temperature, input.maxTokens, input.messages]);
  return createHash('sha256').update(canonical).digest('hex');
}

export class ResponseCache {
  #dir: string;
  #enabled: boolean;

  constructor(dir: string, enabled = true) {
    this.#dir = dir;
    this.#enabled = enabled;
    if (enabled) fs.mkdirSync(dir, { recursive: true });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  #pathFor(hash: string): string {
    // Two-level fan-out keeps the directory listable after a few thousand runs.
    return path.join(this.#dir, hash.slice(0, 2), `${hash}.json`);
  }

  get(hash: string): CachedResponse | null {
    if (!this.#enabled) return null;
    const file = this.#pathFor(hash);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedResponse;
    } catch {
      // A truncated cache entry is not worth a crash; treat it as a miss.
      return null;
    }
  }

  set(hash: string, value: CachedResponse): void {
    if (!this.#enabled) return;
    const file = this.#pathFor(hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
  }
}
