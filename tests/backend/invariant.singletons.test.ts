/**
 * Invariant #4 (CLAUDE.md): cross-route singletons live on `globalThis`.
 *
 * Next.js dev evaluates a server module once per route bundle, so module-scoped
 * mutable state silently becomes N independent copies (the bug class behind
 * "job enqueued in route A, 404 from route B"). This static guard scans
 * `src/lib/**` (minus `src/lib/client/**`, which is browser code) for
 * top-level `let` / `var` bindings and top-level `const X = new Map|Set|...`
 * and fails on anything not in the allowlist below. The runtime counterpart
 * is `tests/e2e/invariant.cross-route-singleton.spec.ts`.
 *
 * The allowlist must not rot: an entry that no longer matches a declaration
 * fails the test too.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface AllowEntry {
  file: string;
  name: string;
  reason: string;
}

const ALLOWLIST: readonly AllowEntry[] = [
  { file: 'src/lib/boot.ts', name: 'booted', reason: 'idempotent boot promise; a per-bundle repeat is harmless' },
  { file: 'src/lib/config.ts', name: 'cached', reason: 'env read cache, read-only after the first call' },
  { file: 'src/lib/paths.ts', name: 'libraryRootOverride', reason: 'test-only override (Vitest runs one module graph)' },
  { file: 'src/lib/bindCheck.ts', name: 'SAFE_HOSTS', reason: 'read-only constant Set' },
  { file: 'src/lib/projects/lookup.ts', name: 'VOLTA_TOOLCHAIN_NAMES', reason: 'read-only constant Set' },
  { file: 'src/lib/projects/relatedDeps.ts', name: 'TOOLCHAIN_NAMES', reason: 'read-only constant Set' },
  { file: 'src/lib/scanners/gitignore.ts', name: 'ALWAYS_SKIP_SET', reason: 'read-only constant Set' },
  { file: 'src/lib/storage/atomic.ts', name: 'RENAME_RETRYABLE_CODES', reason: 'read-only constant Set' }
];

// Top-level only: the patterns are anchored at column 0, which is how every
// module-scope declaration in this repo is formatted (Prettier style).
const LET_OR_VAR = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/;
const CONST_COLLECTION = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/;

const repoRoot = process.cwd();
const libRoot = path.join(repoRoot, 'src', 'lib');

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === path.join(libRoot, 'client')) continue;
      out.push(...(await listSourceFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  name: string;
  line: number;
}

async function findModuleScopedState(): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const file of await listSourceFiles(libRoot)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((text, i) => {
      const m = LET_OR_VAR.exec(text) ?? CONST_COLLECTION.exec(text);
      if (m?.[1] !== undefined) hits.push({ file: rel, name: m[1], line: i + 1 });
    });
  }
  return hits;
}

function isAllowed(hit: Hit): boolean {
  return ALLOWLIST.some((a) => a.file === hit.file && a.name === hit.name);
}

describe('invariant: no module-scoped mutable singletons in src/lib (CLAUDE.md #4)', () => {
  it('every top-level let/var or Map/Set constant is allowlisted with a reason', async () => {
    const offenders = (await findModuleScopedState())
      .filter((h) => !isAllowed(h))
      .map((h) => `${h.file}:${h.line} ${h.name} — move it to globalThis.__DEP_AGENT_<NAME>__ or allowlist it with a reason`);
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still matches a declaration (no stale entries)', async () => {
    const hits = await findModuleScopedState();
    const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && h.name === a.name)).map(
      (a) => `${a.file} ${a.name}`
    );
    expect(stale).toEqual([]);
  });

  it('the scanner detects a module-scoped let and a const Map (self-check)', () => {
    expect(LET_OR_VAR.exec('let token: string | null = null;')?.[1]).toBe('token');
    expect(LET_OR_VAR.exec('export var counter = 0;')?.[1]).toBe('counter');
    expect(CONST_COLLECTION.exec('const STATES = new Map<string, number>();')?.[1]).toBe('STATES');
    expect(CONST_COLLECTION.exec('const CACHE: Map<string, number> = new Map();')?.[1]).toBe('CACHE');
    expect(LET_OR_VAR.exec('  let local = 1;')).toBeNull();
  });
});
