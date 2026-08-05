/**
 * callModel is the only function in this codebase that calls a model
 * (constraint C3). Every provider difference dies inside the transport it
 * selects; every cost, cap and audit concern is settled here, once.
 *
 * A static test (test/one-call-site.test.ts) fails CI if any other file starts
 * talking to a model endpoint directly, because that is exactly how a codebase
 * ends up with three different retry policies and two different cost meters.
 *
 * Ordering inside this function is load-bearing:
 *
 *   1. resolve the slug against the catalog   - a bad slug fails free
 *   2. hash the call                          - the cache key
 *   3. cache lookup                           - a hit costs nothing, so it is
 *                                               checked before the budget
 *   4. log the request                        - C5: written before it is used
 *   5. budget pre-flight                      - trick #5: halt BEFORE spending
 *   6. send
 *   7. log the response the instant it lands  - before parsing touches it
 *   8. record actual spend, then cache
 */
import type { EventLog } from './events.ts';
import type { TokenUsage } from './events.ts';
import type { Catalog } from './catalog.ts';
import type { Transport, Message } from './transport.ts';
import type { BudgetMeter } from './cost.ts';
import type { ResponseCache } from './cache.ts';
import { lookup } from './catalog.ts';
import { estimateCallUsd, priceOf } from './cost.ts';
import { hashCall } from './cache.ts';
import { AosError, isAosError } from './errors.ts';

export interface RouterContext {
  log: EventLog;
  budget: BudgetMeter;
  cache: ResponseCache;
  catalog: Catalog;
  transport: Transport;
}

export interface ModelCall {
  role: string;
  model: string;
  messages: Message[];
  temperature: number;
  maxTokens: number;
  jsonMode?: boolean;
}

export interface ModelResult {
  text: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  ms: number;
  hash: string;
  source: 'live' | 'cache' | 'replay' | 'mock';
}

function sourceFor(kind: Transport['kind']): 'live' | 'replay' | 'mock' {
  return kind === 'http' ? 'live' : kind;
}

export async function callModel(ctx: RouterContext, call: ModelCall): Promise<ModelResult> {
  const entry = lookup(ctx.catalog, call.model);
  const hash = hashCall({
    model: call.model,
    temperature: call.temperature,
    maxTokens: call.maxTokens,
    messages: call.messages,
  });

  const cached = ctx.cache.get(hash);
  const estimateUsd = cached ? 0 : estimateCallUsd(entry, call.messages, call.maxTokens);

  ctx.log.append({
    type: 'model.request',
    role: call.role,
    model: call.model,
    hash,
    messages: call.messages,
    temperature: call.temperature,
    maxTokens: call.maxTokens,
    estimateUsd,
  });

  if (cached) {
    const result: ModelResult = {
      text: cached.text,
      model: call.model,
      usage: cached.usage,
      costUsd: 0,
      ms: 0,
      hash,
      source: 'cache',
    };
    ctx.log.append({
      type: 'model.response',
      role: call.role,
      model: call.model,
      hash,
      text: result.text,
      usage: result.usage,
      costUsd: 0,
      ms: 0,
      source: 'cache',
    });
    return result;
  }

  try {
    ctx.budget.preflight(estimateUsd, { role: call.role, model: call.model });
  } catch (err) {
    if (isAosError(err) && err.code === 'BUDGET_EXCEEDED') {
      ctx.log.append({
        type: 'budget.halt',
        role: call.role,
        spentUsd: ctx.budget.spentUsd,
        estimateUsd,
        budgetUsd: ctx.budget.budgetUsd,
      });
    }
    throw err;
  }

  const started = Date.now();
  let response: { text: string; usage: TokenUsage };
  try {
    response = await ctx.transport.send({
      role: call.role,
      model: call.model,
      messages: call.messages,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      jsonMode: call.jsonMode ?? false,
      hash,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.append({ type: 'model.error', role: call.role, model: call.model, hash, error: message, fatal: true });
    throw isAosError(err) ? err : new AosError('ROUTER', message, { role: call.role, model: call.model });
  }
  const ms = Date.now() - started;

  const costUsd = priceOf(entry, response.usage);
  const source = sourceFor(ctx.transport.kind);

  // Logged before anything parses, validates or repairs it. If the process dies
  // in the next line, the log still shows exactly what the model said.
  ctx.log.append({
    type: 'model.response',
    role: call.role,
    model: call.model,
    hash,
    text: response.text,
    usage: response.usage,
    costUsd,
    ms,
    source,
  });

  ctx.budget.record(costUsd);
  ctx.cache.set(hash, {
    text: response.text,
    usage: response.usage,
    model: call.model,
    storedAt: new Date().toISOString(),
  });

  return { text: response.text, model: call.model, usage: response.usage, costUsd, ms, hash, source };
}
