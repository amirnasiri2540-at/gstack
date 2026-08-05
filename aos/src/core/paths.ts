/**
 * Run directory layout, and the sandbox that keeps model output from writing
 * anywhere it likes (trick #10: every LLM output is untrusted input).
 *
 * A model asked to "save the file" will happily propose ../../.ssh/authorized_keys
 * or /etc/cron.d/x. It is not being malicious; it is completing text. The fix is
 * not a better prompt, it is refusing to resolve the path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AosError } from './errors.ts';

export interface RunPaths {
  /** Directory holding every run, e.g. <repo>/runs */
  root: string;
  runId: string;
  runDir: string;
  artifactsDir: string;
  events: string;
  workorder: string;
  cost: string;
  brief: string;
  verdict: string;
}

export function runPaths(root: string, runId: string): RunPaths {
  const runDir = path.join(root, runId);
  return {
    root,
    runId,
    runDir,
    artifactsDir: path.join(runDir, 'artifacts'),
    events: path.join(runDir, 'events.jsonl'),
    workorder: path.join(runDir, 'workorder.json'),
    cost: path.join(runDir, 'cost.json'),
    brief: path.join(runDir, 'FOUNDER_BRIEF.md'),
    verdict: path.join(runDir, 'verdict.json'),
  };
}

export function ensureRunDirs(p: RunPaths): void {
  fs.mkdirSync(p.artifactsDir, { recursive: true });
}

const MAX_SEGMENTS = 6;
const MAX_LENGTH = 180;

/**
 * Resolve a model-proposed artifact path inside runs/<id>/artifacts, or throw.
 *
 * Checks are deliberately layered rather than clever: a single normalize-and-
 * compare has been defeated too many times by encoding tricks.
 */
export function safeArtifactPath(p: RunPaths, candidate: string): string {
  const reject = (why: string) => {
    throw new AosError('PATH_ESCAPE', `refused artifact path (${why}): ${JSON.stringify(candidate)}`, {
      candidate,
      artifactsDir: p.artifactsDir,
      why,
    });
  };

  if (typeof candidate !== 'string') reject('not a string');
  const raw = candidate.trim();
  if (raw.length === 0) reject('empty');
  if (raw.length > MAX_LENGTH) reject('too long');
  if (/[\u0000-\u001f\u007f]/.test(raw)) reject('control characters');
  if (raw.includes('\\')) reject('backslash');
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) reject('absolute');
  if (raw.startsWith('~')) reject('home expansion');

  const segments = raw.split('/').filter((s) => s !== '.' && s !== '');
  if (segments.length === 0) reject('no filename');
  if (segments.length > MAX_SEGMENTS) reject('too deep');
  if (segments.some((s) => s === '..')) reject('parent traversal');
  if (segments.some((s) => s.startsWith('.'))) reject('dotfile');

  const resolved = path.resolve(p.artifactsDir, segments.join('/'));
  const base = path.resolve(p.artifactsDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) reject('escapes sandbox');

  // A pre-existing symlink inside the sandbox could still point outward.
  const existingParent = nearestExistingAncestor(path.dirname(resolved));
  if (fs.realpathSync(existingParent) !== existingParent) reject('symlinked parent');

  return resolved;
}

function nearestExistingAncestor(dir: string): string {
  let cur = dir;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/** Write an artifact through the sandbox. The only artifact writer in the app. */
export function writeArtifact(p: RunPaths, candidate: string, contents: string): { path: string; bytes: number } {
  const target = safeArtifactPath(p, candidate);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf-8');
  return { path: path.relative(p.runDir, target), bytes: Buffer.byteLength(contents, 'utf-8') };
}
