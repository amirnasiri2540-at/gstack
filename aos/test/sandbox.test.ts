/**
 * Trick #10: every LLM output is untrusted input. These are the paths a model
 * has actually proposed in the wild, plus the encodings that defeat a naive
 * normalize-and-compare.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPaths, ensureRunDirs, safeArtifactPath, writeArtifact } from '../src/core/paths.ts';
import { AosError } from '../src/core/errors.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sandbox-'));
  const p = runPaths(path.join(root, 'runs'), 'run_test');
  ensureRunDirs(p);
  return { root, p };
}

const REJECTED = [
  '../../../etc/passwd',
  '..',
  '../outside.html',
  '/etc/cron.d/aos',
  '/tmp/evil.sh',
  '~/.ssh/authorized_keys',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'nested\\windows\\path.html',
  '.env',
  'sub/.git/config',
  'a/b/c/d/e/f/g/too-deep.html',
  '',
  '   ',
  'index\u0000.html',
];

test('paths that escape the run sandbox are refused', () => {
  const { root, p } = fixture();
  for (const bad of REJECTED) {
    assert.throws(
      () => safeArtifactPath(p, bad),
      (err: unknown) => err instanceof AosError && err.code === 'PATH_ESCAPE',
      `should have refused: ${JSON.stringify(bad)}`,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('ordinary artifact paths resolve inside artifacts/', () => {
  const { root, p } = fixture();
  for (const ok of ['index.html', './index.html', 'src/app.js', 'test/smoke.test.js']) {
    const resolved = safeArtifactPath(p, ok);
    assert.ok(resolved.startsWith(path.resolve(p.artifactsDir) + path.sep), ok);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeArtifact returns a run-relative path and byte count', () => {
  const { root, p } = fixture();
  const res = writeArtifact(p, 'index.html', '<!doctype html><title>hi</title>');
  assert.equal(res.path, path.join('artifacts', 'index.html'));
  assert.equal(res.bytes, 32);
  assert.ok(fs.existsSync(path.join(p.artifactsDir, 'index.html')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a symlinked parent inside the sandbox is still refused', () => {
  const { root, p } = fixture();
  const escape = path.join(root, 'escape');
  fs.mkdirSync(escape);
  fs.symlinkSync(escape, path.join(p.artifactsDir, 'link'));
  assert.throws(
    () => safeArtifactPath(p, 'link/pwned.html'),
    (err: unknown) => err instanceof AosError && err.code === 'PATH_ESCAPE',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
