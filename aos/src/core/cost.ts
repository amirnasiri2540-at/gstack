/**
 * Cost meter with a pre-flight estimate (trick #5).
 *
 * The point is the ordering. A budget checked after the response has arrived is
 * a receipt, not a cap. This checks before the request goes out, and a run that
 * would cross the cap halts without spending the token that crossed it.
 *
 * The estimate is a heuristic, not a tokenizer, and it is deliberately biased to
 * over-estimate: prompt characters are divided by 3 (English averages closer to
 * 4 characters per token) and the completion is priced at the full max_tokens
 * even though most replies are shorter. An under-estimating cap leaks money; an
 * over-estimating cap only stops a little early, which is the failure you want.
 */
import { AosError } from './errors.ts';
import type { CatalogEntry } from './catalog.ts';
import type { TokenUsage } from './events.ts';

const CHARS_PER_TOKEN_CONSERVATIVE = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_CONSERVATIVE);
}

export function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  // ~4 tokens of per-message framing overhead, matching common chat encodings.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export function priceOf(entry: CatalogEntry, usage: TokenUsage): number {
  return usage.promptTokens * entry.promptUsdPerToken + usage.completionTokens * entry.completionUsdPerToken;
}

export function estimateCallUsd(
  entry: CatalogEntry,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): number {
  return priceOf(entry, { promptTokens: estimatePromptTokens(messages), completionTokens: maxTokens });
}

export class BudgetMeter {
  #budgetUsd: number;
  #spentUsd: number;

  constructor(budgetUsd: number, spentUsd = 0) {
    if (!(budgetUsd > 0)) throw new TypeError(`budget must be positive, got ${budgetUsd}`);
    this.#budgetUsd = budgetUsd;
    this.#spentUsd = spentUsd;
  }

  get budgetUsd(): number {
    return this.#budgetUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.#budgetUsd - this.#spentUsd);
  }

  wouldExceed(estimateUsd: number): boolean {
    return this.#spentUsd + estimateUsd > this.#budgetUsd;
  }

  /** Throws before the caller is allowed to spend. This is the cap. */
  preflight(estimateUsd: number, context: Record<string, unknown> = {}): void {
    if (this.wouldExceed(estimateUsd)) {
      throw new AosError(
        'BUDGET_EXCEEDED',
        `budget cap reached: spent $${this.#spentUsd.toFixed(4)} + estimate $${estimateUsd.toFixed(4)} > cap $${this.#budgetUsd.toFixed(2)}`,
        { ...context, spentUsd: this.#spentUsd, estimateUsd, budgetUsd: this.#budgetUsd },
      );
    }
  }

  /** Records what was actually billed, which is usually less than the estimate. */
  record(actualUsd: number): number {
    this.#spentUsd += actualUsd;
    return this.#spentUsd;
  }
}
