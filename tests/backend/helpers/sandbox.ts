/**
 * Test sandbox helpers — every test that touches the library or a fixture
 * project creates its own isolated tempdir, never touching the developer's
 * real state (spec §3.5).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { setLibraryRoot } from '@/lib/paths';
import { resetEnvCache } from '@/lib/config';

export interface Sandbox {
  /** Library root for this test. */
  libraryRoot: string;
  /** A scratch dir for fixture target projects. */
  scratchRoot: string;
  /** Build a sub-path under scratchRoot (auto-created). */
  scratch: (...segments: string[]) => Promise<string>;
  /** Tear down everything; called by test `afterEach`. */
  dispose: () => Promise<void>;
}

const ROOTS = new Set<string>();

export async function createSandbox(name = 'dep-agent-test'): Promise<Sandbox> {
  const id = `${name}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const base = path.join(os.tmpdir(), id);
  const libraryRoot = path.join(base, 'library');
  const scratchRoot = path.join(base, 'scratch');
  await fs.mkdir(libraryRoot, { recursive: true });
  await fs.mkdir(scratchRoot, { recursive: true });
  setLibraryRoot(libraryRoot);
  resetEnvCache();
  ROOTS.add(base);

  return {
    libraryRoot,
    scratchRoot,
    scratch: async (...segments) => {
      const full = path.join(scratchRoot, ...segments);
      await fs.mkdir(full, { recursive: true });
      return full;
    },
    dispose: async () => {
      setLibraryRoot(null);
      ROOTS.delete(base);
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export async function disposeAllSandboxes(): Promise<void> {
  for (const root of Array.from(ROOTS)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  ROOTS.clear();
  setLibraryRoot(null);
}
