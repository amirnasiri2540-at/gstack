/**
 * The model catalog. Constraint C7: no model id is ever typed from memory.
 *
 * Model slugs go stale faster than anything else in an LLM codebase, and a
 * stale slug fails as a 404 three roles deep into a run, after you have already
 * paid for the first two. So `npm run setup` fetches the live list from the
 * router, filters it, and writes real slugs into config/routing.yaml. Prices
 * come from the same fetch, which means the cost meter is quoting the router's
 * numbers rather than a number someone remembered.
 *
 * config/routing.yaml ships with <<FILL_FROM_LIVE_MODEL_LIST>> placeholders and
 * the role loader refuses to run until they are resolved. An unresolved
 * placeholder is a loud failure at startup; a guessed slug is a quiet failure
 * at spend time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AosError } from './errors.ts';

export const PLACEHOLDER = '<<FILL_FROM_LIVE_MODEL_LIST>>';

export const CatalogEntry = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextLength: z.number().optional(),
  promptUsdPerToken: z.number().nonnegative(),
  completionUsdPerToken: z.number().nonnegative(),
  provider: z.string(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const Catalog = z.object({
  fetchedAt: z.string(),
  /** live = fetched from the router, file = operator-supplied, mock = offline demo. */
  source: z.enum(['live', 'file', 'mock']),
  baseUrl: z.string(),
  models: z.array(CatalogEntry),
});
export type Catalog = z.infer<typeof Catalog>;

/** The slug's leading segment. "anthropic/claude-x" -> "anthropic". */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

/**
 * The router's /models response, as loosely as we can get away with. Routers
 * add fields constantly; we pin only what we read.
 */
const RouterModelsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      pricing: z
        .object({
          prompt: z.union([z.string(), z.number()]).nullish(),
          completion: z.union([z.string(), z.number()]).nullish(),
        })
        .nullish(),
    }),
  ),
});

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function normalizeCatalog(raw: unknown, baseUrl: string, fetchedAt: string, source: 'live' | 'file'): Catalog {
  const parsed = RouterModelsResponse.safeParse(raw);
  if (!parsed.success) {
    throw new AosError('CATALOG', 'router /models response did not match the expected shape', {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  const models = parsed.data.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length ?? undefined,
    promptUsdPerToken: toNumber(m.pricing?.prompt),
    completionUsdPerToken: toNumber(m.pricing?.completion),
    provider: providerOf(m.id),
  }));
  return Catalog.parse({ fetchedAt, source, baseUrl, models });
}

export async function fetchCatalog(baseUrl: string, timeoutMs = 30_000): Promise<Catalog> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AosError('CATALOG', `could not reach the router model list at ${url}: ${(err as Error).message}`, {
      url,
      hint: 'If egress is restricted, download the list elsewhere and run: npm run setup -- --from-file <path>',
    });
  }
  if (!res.ok) {
    throw new AosError('CATALOG', `router model list returned HTTP ${res.status}`, { url, status: res.status });
  }
  return normalizeCatalog(await res.json(), baseUrl, new Date().toISOString(), 'live');
}

/** Marker that makes an offline stub unmistakable in a log, a config or a bill. */
export const OFFLINE_STUB = 'offline-stub';

/**
 * The offline catalog, for exercising the machine without a key.
 *
 * Stubs are published under the *real* provider names so that `npm run setup`
 * runs its actual provider-preference and price-tier logic against them rather
 * than around it. The model half of each slug says OFFLINE-STUB in the clear,
 * so no log line, cost report or config file can be mistaken for a live run,
 * and the http transport refuses to send one.
 */
export function mockCatalog(baseUrl: string, fetchedAt: string): Catalog {
  const providers = ['google', 'openai', 'anthropic', 'x-ai'];
  const tiers: Array<[string, number, number]> = [
    ['cheap', 0.0000002, 0.0000008],
    ['mid', 0.000003, 0.000015],
    ['top', 0.000015, 0.000075],
  ];
  const models: CatalogEntry[] = [];
  for (const provider of providers) {
    for (const [tier, p, c] of tiers) {
      const id = `${provider}/${OFFLINE_STUB}-${tier}`;
      models.push({
        id,
        name: `OFFLINE STUB (${provider}, ${tier} tier) - not a model`,
        contextLength: 200_000,
        promptUsdPerToken: p,
        completionUsdPerToken: c,
        provider,
      });
    }
  }
  return Catalog.parse({ fetchedAt, source: 'mock', baseUrl, models });
}

export function isMockModel(modelId: string): boolean {
  return modelId.includes(OFFLINE_STUB);
}

export function loadCatalog(file: string): Catalog {
  if (!fs.existsSync(file)) {
    throw new AosError('CATALOG', `no model catalog at ${file}. Run: npm run setup`, { file });
  }
  return Catalog.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

export function saveCatalog(file: string, catalog: Catalog): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
}

export function lookup(catalog: Catalog, modelId: string): CatalogEntry {
  if (modelId.includes(PLACEHOLDER)) {
    throw new AosError('MODEL_UNRESOLVED', `config still contains ${PLACEHOLDER}. Run: npm run setup`, { modelId });
  }
  const hit = catalog.models.find((m) => m.id === modelId);
  if (!hit) {
    throw new AosError('MODEL_UNRESOLVED', `model "${modelId}" is not in the catalog fetched at ${catalog.fetchedAt}`, {
      modelId,
      catalogSource: catalog.source,
      hint: 'Re-run `npm run setup` to refresh the list, or pick a slug the router actually serves.',
    });
  }
  return hit;
}
