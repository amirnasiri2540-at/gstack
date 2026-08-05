/**
 * Constraint C3 as a tripwire, not a promise.
 *
 * If a future change adds a second place that talks to a model endpoint, this
 * fails. That is the whole point: three retry policies and two cost meters is
 * how an orchestration codebase stops being auditable, and it always arrives
 * one innocent-looking fetch at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** transport.ts owns HTTP to models; catalog.ts owns the model-list fetch. */
const FETCH_ALLOWED = new Set([path.join('core', 'transport.ts'), path.join('core', 'catalog.ts')]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

test('only transport.ts and catalog.ts make network calls', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    if (FETCH_ALLOWED.has(rel)) continue;
    const body = fs.readFileSync(file, 'utf-8');
    // Strip block comments so prose about fetch does not trip the check.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/\bfetch\s*\(/.test(code) || /\bhttps?\.request\s*\(/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `network calls outside the allowed transports: ${offenders.join(', ')}`);
});

test('only router.ts invokes a transport send()', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    if (rel === path.join('core', 'router.ts') || rel === path.join('core', 'transport.ts')) continue;
    const code = fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/transport\s*\.\s*send\s*\(/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `transport.send() called outside router.ts: ${offenders.join(', ')}`);
});
