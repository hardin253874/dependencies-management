/**
 * Resolver check unit tests (spec §10.7, plan Stage 3).
 *
 *  - TempSandbox: create, populate from target dir, cleanup on success.
 *  - npm binary resolution: Volta wins, falls through to PATH, RESOLVER_NPM_MISSING.
 *  - Dry-run happy path: clean exit → wouldResolve:true, no conflicts.
 *  - ERESOLVE: first attempt fails; auto-retry with --legacy-peer-deps succeeds.
 *  - Boot-time temp sweep deletes orphans > 1h old.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import {
  createTempSandbox,
  resolveNpmBinary,
  runResolverCheck,
  parseEresolve,
  SANDBOX_FILES,
  type SpawnLike
} from '@/lib/scanners/resolver';
import { depAgentTempRoot, sweepTempSandboxes } from '@/lib/jobs/tempSweep';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

// ---------------------------------------------------------------------------
// TempSandbox helpers
// ---------------------------------------------------------------------------

describe('createTempSandbox', () => {
  it('creates a temp dir under os.tmpdir()/dep-agent and copies the sandbox files', async () => {
    sandbox = await createSandbox('resolver-temp');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const jobId = `t-${crypto.randomBytes(4).toString('hex')}`;
    const dir = await createTempSandbox(target, jobId);
    try {
      expect(dir).toContain('dep-agent');
      expect(path.basename(dir)).toBe(jobId);
      expect(await fileExists(path.join(dir, 'package.json'))).toBe(true);
      expect(await fileExists(path.join(dir, 'package-lock.json'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('only copies files in SANDBOX_FILES (does not pull node_modules / src)', async () => {
    sandbox = await createSandbox('resolver-restrict');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);
    await fs.mkdir(path.join(target, 'src'), { recursive: true });
    await fs.writeFile(path.join(target, 'src', 'index.ts'), 'export {}');

    const dir = await createTempSandbox(target, `t-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const entries = await fs.readdir(dir);
      for (const e of entries) {
        expect(SANDBOX_FILES as readonly string[]).toContain(e);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// npm binary resolution (G32)
// ---------------------------------------------------------------------------

describe('resolveNpmBinary', () => {
  it('prefers Volta when the volta-installed npm exists', async () => {
    sandbox = await createSandbox('npm-resolve-volta');
    const voltaBin = path.join(sandbox.scratchRoot, 'npm.cmd');
    await fs.writeFile(voltaBin, 'echo volta');
    const r = await resolveNpmBinary({
      voltaNpmBin: voltaBin,
      pathLookup: async () => '/usr/local/bin/npm'
    });
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.source).toBe('volta');
      expect(r.bin).toBe(voltaBin);
    }
  });

  it('falls back to PATH when no Volta binary configured', async () => {
    const r = await resolveNpmBinary({
      voltaNpmBin: null,
      pathLookup: async (name) => (name === 'npm' ? '/usr/local/bin/npm' : null)
    });
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.source).toBe('path');
    }
  });

  it('returns kind:missing when neither source resolves', async () => {
    const r = await resolveNpmBinary({
      voltaNpmBin: null,
      pathLookup: async () => null
    });
    expect(r.kind).toBe('missing');
    if (r.kind === 'missing') {
      expect(r.triedLocations.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// runResolverCheck — happy path + ERESOLVE + retry
// ---------------------------------------------------------------------------

function makeFakeSpawn(scripts: Array<{ stdout?: string; stderr?: string; exitCode: number }>): { spawn: SpawnLike; calls: Array<{ cmd: string; args: ReadonlyArray<string> }> } {
  const calls: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  let i = 0;
  const spawn: SpawnLike = (cmd, args) => {
    const script = scripts[i++] ?? { exitCode: 0 };
    calls.push({ cmd, args });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as unknown as {
      stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void };
      stderr: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void };
      on: (event: 'close' | 'error', listener: (arg?: number | Error) => void) => void;
    };
    (proc as unknown as { stdout: EventEmitter }).stdout = stdout;
    (proc as unknown as { stderr: EventEmitter }).stderr = stderr;
    // Fire the events on next tick so the consumer's `proc.on('close', ...)`
    // has time to register.
    setImmediate(() => {
      if (script.stdout !== undefined) stdout.emit('data', Buffer.from(script.stdout));
      if (script.stderr !== undefined) stderr.emit('data', Buffer.from(script.stderr));
      (proc as unknown as EventEmitter).emit('close', script.exitCode);
    });
    return proc as unknown as ReturnType<SpawnLike>;
  };
  return { spawn, calls };
}

describe('runResolverCheck — happy path', () => {
  it('returns wouldResolve:true on a clean dry-run', async () => {
    sandbox = await createSandbox('resolver-happy');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const fake = makeFakeSpawn([{ stdout: '{"dryRun":true}', stderr: '', exitCode: 0 }]);
    const r = await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId: `t-${crypto.randomBytes(4).toString('hex')}`,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'found', bin: 'fake-npm', source: 'path' }),
      spawnImpl: fake.spawn
    });

    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.wouldResolve).toBe(true);
      expect(r.conflicts).toEqual([]);
      expect(r.legacyPeerDepsUsed).toBe(false);
    }
  });

  it('deletes the sandbox after the run', async () => {
    sandbox = await createSandbox('resolver-cleanup');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);
    const jobId = `t-${crypto.randomBytes(4).toString('hex')}`;

    const fake = makeFakeSpawn([{ stdout: '', stderr: '', exitCode: 0 }]);
    const r = await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'found', bin: 'fake-npm', source: 'path' }),
      spawnImpl: fake.spawn
    });

    expect(r.enabled).toBe(true);
    const expectedDir = path.join(depAgentTempRoot(), jobId);
    expect(await fileExists(expectedDir)).toBe(false);
  });
});

describe('runResolverCheck — ERESOLVE retry with --legacy-peer-deps', () => {
  it('retries with --legacy-peer-deps and succeeds, marking legacyPeerDepsUsed:true', async () => {
    sandbox = await createSandbox('resolver-eresolve-retry');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const fake = makeFakeSpawn([
      { stdout: '', stderr: 'npm ERR! code ERESOLVE\nnpm ERR! peer react@"^18" from styled-thing@1.0.0', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 }
    ]);

    const r = await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId: `t-${crypto.randomBytes(4).toString('hex')}`,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'found', bin: 'fake-npm', source: 'path' }),
      spawnImpl: fake.spawn
    });

    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.wouldResolve).toBe(true);
      expect(r.legacyPeerDepsUsed).toBe(true);
    }
    // The second spawn should include --legacy-peer-deps.
    expect(fake.calls[1]?.args).toContain('--legacy-peer-deps');
  });

  it('returns wouldResolve:false + conflicts when retry also fails', async () => {
    sandbox = await createSandbox('resolver-eresolve-fail');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const fake = makeFakeSpawn([
      { stdout: '', stderr: 'npm ERR! code ERESOLVE\nnpm ERR! peer react@"^18" from styled-thing@1.0.0', exitCode: 1 },
      { stdout: '', stderr: 'npm ERR! code ERESOLVE\nnpm ERR! peer react@"^18" from styled-thing@1.0.0', exitCode: 1 }
    ]);

    const r = await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId: `t-${crypto.randomBytes(4).toString('hex')}`,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'found', bin: 'fake-npm', source: 'path' }),
      spawnImpl: fake.spawn
    });

    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.wouldResolve).toBe(false);
      expect(r.conflicts.length).toBeGreaterThan(0);
    }
  });
});

describe('runResolverCheck — RESOLVER_NPM_MISSING', () => {
  it('returns a disabled result with errorCode when npm cannot be located', async () => {
    sandbox = await createSandbox('resolver-no-npm');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const r = await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId: `t-${crypto.randomBytes(4).toString('hex')}`,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'missing', triedLocations: ['path:not-found'] })
    });

    expect(r.enabled).toBe(false);
    if (!r.enabled) {
      expect(r.reason).toBe('resolver-failed');
      expect(r.errorCode).toBe('RESOLVER_NPM_MISSING');
    }
  });
});

// ---------------------------------------------------------------------------
// parseEresolve — sanity
// ---------------------------------------------------------------------------

describe('parseEresolve', () => {
  it('extracts conflicts from npm stderr peer hints', () => {
    const stderr =
      'npm ERR! code ERESOLVE\nnpm ERR! peer react@"^17" from older-thing@1.0.0';
    const conflicts = parseEresolve('not-json', stderr);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]?.package).toBe('older-thing');
  });
});

// ---------------------------------------------------------------------------
// Target read-only invariant under resolver run (§16.3 BLOCKER)
// ---------------------------------------------------------------------------

import { snapshotDirectory } from './helpers/fixtures';

describe('target read-only invariant — resolver (§16.3)', () => {
  it('does not modify the target directory during runResolverCheck even on ERESOLVE retry', async () => {
    sandbox = await createSandbox('resolver-readonly');
    const target = await sandbox.scratch('proj');
    await createSmallNpmProject(target);

    const before = await snapshotDirectory(target);

    const fake = makeFakeSpawn([
      { stdout: '', stderr: 'npm ERR! code ERESOLVE\nnpm ERR! peer react@"^18" from styled-thing@1.0.0', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 }
    ]);

    await runResolverCheck({
      projectRoot: target,
      depName: 'react',
      toVersion: '19.0.0',
      jobId: `t-${crypto.randomBytes(4).toString('hex')}`,
      legacyPeerDepsAlready: false,
      voltaNpmBin: null,
      npmResolver: async () => ({ kind: 'found', bin: 'fake-npm', source: 'path' }),
      spawnImpl: fake.spawn
    });

    const after = await snapshotDirectory(target);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// Boot-time temp sweep (§16.3)
// ---------------------------------------------------------------------------

describe('boot-time temp sweep', () => {
  it('deletes entries older than the configured maxAgeMs and keeps fresh ones', async () => {
    const root = depAgentTempRoot();
    await fs.mkdir(root, { recursive: true });

    const oldId = `old-${crypto.randomBytes(4).toString('hex')}`;
    const newId = `new-${crypto.randomBytes(4).toString('hex')}`;
    const oldDir = path.join(root, oldId);
    const newDir = path.join(root, newId);
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });

    // Back-date the old dir by 2 hours.
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    await fs.utimes(oldDir, twoHoursAgo / 1000, twoHoursAgo / 1000);

    const result = await sweepTempSandboxes(3_600_000);

    expect(result.removed.some((p) => p.endsWith(oldId))).toBe(true);
    expect(result.kept.some((p) => p.endsWith(newId))).toBe(true);
    // Cleanup our test fixtures regardless of outcome.
    await fs.rm(newDir, { recursive: true, force: true }).catch(() => undefined);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Reference avoidance for unused import warnings; the import keeps the symbol
// in scope for IDE jump-to-definition.
void os;
