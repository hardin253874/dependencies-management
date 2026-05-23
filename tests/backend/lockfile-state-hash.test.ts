/**
 * Lockfile-state hash determinism (spec §8.2 + §10.1 Phase 1).
 *
 * Two lockfiles that resolve to the SAME set of (name, version) pairs must
 * produce the SAME `lockfileStateHash` regardless of formatting differences
 * (whitespace, key order, redundant fields).
 *
 * The current implementation hashes a sorted `name@version` join — this test
 * pins that contract so a future refactor can't silently bust deep-report
 * caches with format-only diffs.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { detectLockfile, parseLockfile } from '@/lib/scanners/lockfile';

async function writeNpmLock(dir: string, json: object): Promise<void> {
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(json));
}

async function makeTempDir(): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `lf-hash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('lockfileStateHash determinism', () => {
  it('same resolved set in different formatting produces the same state hash', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    try {
      const compactJson = {
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/react': { version: '18.3.1', name: 'react' },
          'node_modules/lodash': { version: '4.17.21', name: 'lodash' }
        }
      };
      // Pretty-printed shape with key reordering for B.
      const prettyJson = {
        version: '1.0.0',
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          'node_modules/lodash': { name: 'lodash', version: '4.17.21' },
          '': { version: '1.0.0', name: 'fixture' },
          'node_modules/react': { name: 'react', version: '18.3.1' }
        }
      };

      await writeNpmLock(dirA, compactJson);
      await writeNpmLock(dirB, prettyJson);

      const detA = await detectLockfile(dirA);
      const detB = await detectLockfile(dirB);
      expect(detA).not.toBeNull();
      expect(detB).not.toBeNull();
      const a = await parseLockfile(detA!);
      const b = await parseLockfile(detB!);
      expect(a.lockfileStateHash).toBe(b.lockfileStateHash);
      // Raw bytes differ → lockfileHash should differ (sanity check).
      expect(a.lockfileHash).not.toBe(b.lockfileHash);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(dirB, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('different resolved set produces a different state hash', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    try {
      const a = {
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/react': { version: '18.3.1', name: 'react' }
        }
      };
      const b = {
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0' },
          'node_modules/react': { version: '19.0.0', name: 'react' } // changed
        }
      };
      await writeNpmLock(dirA, a);
      await writeNpmLock(dirB, b);
      const lockA = await parseLockfile((await detectLockfile(dirA))!);
      const lockB = await parseLockfile((await detectLockfile(dirB))!);
      expect(lockA.lockfileStateHash).not.toBe(lockB.lockfileStateHash);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(dirB, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
