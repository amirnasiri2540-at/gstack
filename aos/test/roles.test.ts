/**
 * Roles are data (C4), and the constraints that make the six-role split worth
 * paying for are enforced at load time rather than discovered mid-run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRoles, parseRoleFile, requireRole } from '../src/core/roles.ts';
import { RoutingLock } from '../src/core/routing.ts';
import { FILES } from '../src/core/project.ts';
import { AosError } from '../src/core/errors.ts';

const LOCK = RoutingLock.parse({
  version: 1,
  catalog: { source: 'mock', fetchedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.invalid/v1' },
  roles: {
    MUSE: { model: 'google/offline-stub-cheap', fallback: 'openai/offline-stub-cheap', parallel: [] },
    ATLAS: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    FORGE: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    ECHO: {
      model: 'google/offline-stub-mid',
      fallback: 'openai/offline-stub-mid',
      parallel: ['openai/offline-stub-mid'],
    },
    SENTINEL: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    HERALD: { model: 'google/offline-stub-cheap', fallback: 'openai/offline-stub-cheap', parallel: [] },
  },
});

test('the six shipped role files load and bind to their models', () => {
  const roles = loadRoles(FILES.rolesDir, LOCK);
  assert.deepEqual([...roles.keys()].sort(), ['ATLAS', 'ECHO', 'FORGE', 'HERALD', 'MUSE', 'SENTINEL']);

  const echo = requireRole(roles, 'ECHO');
  assert.equal(echo.schemaName, 'CritiqueReport');
  assert.deepEqual(echo.mustDifferFrom, ['ATLAS', 'FORGE']);
  assert.equal(echo.parallel.length, 1, 'ECHO runs a second critic on another provider');

  // The routing hypothesis in section 4, verified rather than assumed.
  assert.equal(requireRole(roles, 'MUSE').temperature, 0.9, 'divergence wants a high temperature');
  assert.ok(requireRole(roles, 'ATLAS').temperature <= 0.3, 'planning wants a low one');
});

test('a critic sharing a provider with the builder is refused before the run starts', () => {
  const collided = RoutingLock.parse({
    ...LOCK,
    roles: {
      ...LOCK.roles,
      // ECHO dragged onto anthropic, the same provider as ATLAS and FORGE.
      ECHO: { model: 'anthropic/offline-stub-mid', fallback: 'openai/offline-stub-mid', parallel: [] },
    },
  });
  assert.throws(
    () => loadRoles(FILES.rolesDir, collided),
    (err: unknown) => err instanceof AosError && err.code === 'PROVIDER_DIVERSITY' && /ECHO/.test(err.message),
  );
});

test('a role with no routing entry fails loudly instead of defaulting', () => {
  const { HERALD: _dropped, ...rest } = LOCK.roles;
  const missing = RoutingLock.parse({ ...LOCK, roles: rest });
  assert.throws(
    () => loadRoles(FILES.rolesDir, missing),
    (err: unknown) => err instanceof AosError && err.code === 'MODEL_UNRESOLVED',
  );
});

test('a role naming an output schema that does not exist is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-roles-'));
  const file = path.join(dir, 'bad.yaml');
  fs.writeFileSync(
    file,
    [
      'name: BAD',
      'title: A role naming a schema nobody wrote',
      'temperature: 0.2',
      'max_tokens: 100',
      'output_schema: SchemaThatDoesNotExist',
      'system_prompt: |',
      '  This prompt is long enough to satisfy the minimum length requirement here.',
    ].join('\n'),
  );
  assert.throws(
    () => parseRoleFile(file),
    (err: unknown) => err instanceof AosError && err.code === 'ROLE_CONFIG' && /does not exist/.test(err.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adding a seventh role is adding a file, and it needs no code change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-roles7-'));
  for (const f of fs.readdirSync(FILES.rolesDir)) {
    fs.copyFileSync(path.join(FILES.rolesDir, f), path.join(dir, f));
  }
  fs.writeFileSync(
    path.join(dir, 'scribe.yaml'),
    [
      'name: SCRIBE',
      'title: A seventh role added with zero code changes',
      'temperature: 0.3',
      'max_tokens: 800',
      'output_schema: DeliveryPackage',
      'must_differ_from: [FORGE]',
      'system_prompt: |',
      '  You exist only to prove that roles are data and not code in this system.',
    ].join('\n'),
  );

  const lock = RoutingLock.parse({
    ...LOCK,
    roles: {
      ...LOCK.roles,
      SCRIBE: { model: 'google/offline-stub-cheap', fallback: 'openai/offline-stub-cheap', parallel: [] },
    },
  });

  const roles = loadRoles(dir, lock);
  assert.equal(roles.size, 7);
  assert.equal(requireRole(roles, 'SCRIBE').title, 'A seventh role added with zero code changes');
  fs.rmSync(dir, { recursive: true, force: true });
});
