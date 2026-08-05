/**
 * Assembles everything a run needs. Adapters call this and then consume the
 * generator; they never wire a transport or a budget meter themselves.
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import { FILES, routerApiKey, routerBaseUrl } from './project.ts';
import { loadCatalog } from './catalog.ts';
import { RoutingLock, unresolvedRoles } from './routing.ts';
import { loadRoles } from './roles.ts';
import type { RuntimeRole } from './roles.ts';
import { EventLog, readEvents, eventsOfType } from './events.ts';
import { liveSequencer, newRunId } from './ids.ts';
import type { Sequencer } from './ids.ts';
import { runPaths, ensureRunDirs } from './paths.ts';
import type { RunPaths } from './paths.ts';
import { BudgetMeter } from './cost.ts';
import { ResponseCache } from './cache.ts';
import { httpTransport, mockTransport, replayTransport } from './transport.ts';
import type { Transport } from './transport.ts';
import { offlineResponder } from './offline-responder.ts';
import { newWorkOrder } from './schema.ts';
import type { WorkOrder } from './schema.ts';
import type { RouterContext } from './router.ts';
import { AosError } from './errors.ts';

export interface RuntimeOptions {
  idea: string;
  budgetUsd: number;
  constraints?: string[];
  cache?: boolean;
  /** Replay a previous run's recorded responses instead of calling anything. */
  replayFrom?: string;
  runId?: string;
  seq?: Sequencer;
}

export interface Runtime {
  wo: WorkOrder;
  paths: RunPaths;
  roles: Map<string, RuntimeRole>;
  ctx: RouterContext;
  seq: Sequencer;
}

export function loadRoutingLock(): RoutingLock {
  if (!fs.existsSync(FILES.routingLock)) {
    throw new AosError('MODEL_UNRESOLVED', 'no config/routing.lock.yaml. Run: npm run setup', {
      hint: 'Offline? npm run setup -- --offline',
    });
  }
  const lock = RoutingLock.parse(yaml.load(fs.readFileSync(FILES.routingLock, 'utf-8')));
  const unresolved = unresolvedRoles(lock);
  if (unresolved.length > 0) {
    throw new AosError('MODEL_UNRESOLVED', `these roles have no model slug yet: ${unresolved.join(', ')}`, {
      hint: 'Run: npm run setup',
    });
  }
  return lock;
}

function chooseTransport(catalogSource: string, idea: string, replayFrom?: string): Transport {
  if (replayFrom) {
    const recorded = new Map<string, { text: string; usage: { promptTokens: number; completionTokens: number } }>();
    for (const e of eventsOfType(readEvents(replayFrom), 'model.response')) {
      recorded.set(e.hash, { text: e.text, usage: e.usage });
    }
    if (recorded.size === 0) {
      throw new AosError('REPLAY_MISS', `${replayFrom} contains no recorded model responses`, { file: replayFrom });
    }
    return replayTransport(recorded);
  }

  if (catalogSource === 'mock') return mockTransport(offlineResponder(idea));

  const apiKey = routerApiKey();
  if (!apiKey) {
    throw new AosError('ROUTER', 'no router API key. Set AOS_ROUTER_API_KEY (or OPENROUTER_API_KEY) in .env', {
      hint: 'To exercise the pipeline with no key at all: npm run setup -- --offline',
    });
  }
  return httpTransport({ baseUrl: routerBaseUrl(), apiKey, referer: 'https://github.com/aos-maestro', title: 'AOS' });
}

export function buildRuntime(opts: RuntimeOptions): Runtime {
  const catalog = loadCatalog(FILES.catalog);
  const lock = loadRoutingLock();
  const roles = loadRoles(FILES.rolesDir, lock);

  const seq = opts.seq ?? liveSequencer();
  const runId = opts.runId ?? newRunId();
  const paths = runPaths(FILES.runsDir, runId);
  ensureRunDirs(paths);

  const log = new EventLog(paths.events, seq);
  const ctx: RouterContext = {
    log,
    budget: new BudgetMeter(opts.budgetUsd),
    cache: new ResponseCache(FILES.cacheDir, opts.cache ?? true),
    catalog,
    transport: chooseTransport(catalog.source, opts.idea, opts.replayFrom),
  };

  const wo = newWorkOrder({
    id: runId,
    createdAt: new Date().toISOString(),
    idea: opts.idea,
    constraints: opts.constraints ?? [],
    budgetUsd: opts.budgetUsd,
  });

  return { wo, paths, roles, ctx, seq };
}
