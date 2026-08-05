/** Where things live. One place, so no module invents its own layout. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FILES = {
  configDir: path.join(PROJECT_ROOT, 'config'),
  routing: path.join(PROJECT_ROOT, 'config', 'routing.yaml'),
  routingLock: path.join(PROJECT_ROOT, 'config', 'routing.lock.yaml'),
  catalog: path.join(PROJECT_ROOT, 'config', 'catalog.json'),
  rolesDir: path.join(PROJECT_ROOT, 'roles'),
  cacheDir: path.join(PROJECT_ROOT, '.cache'),
  runsDir: path.join(PROJECT_ROOT, 'runs'),
} as const;

export const DEFAULT_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function routerBaseUrl(): string {
  return process.env.AOS_ROUTER_BASE_URL ?? DEFAULT_ROUTER_BASE_URL;
}

export function routerApiKey(): string | undefined {
  return process.env.AOS_ROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
}
