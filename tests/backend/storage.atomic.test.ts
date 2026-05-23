import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteJson, readJson } from '@/lib/storage/atomic';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('atomicWriteJson', () => {
  it('writes a file with the expected JSON content', async () => {
    sandbox = await createSandbox('atomic-basic');
    const fp = path.join(sandbox.libraryRoot, 'sub', 'a.json');
    await atomicWriteJson(fp, { x: 1, y: 'two' });
    const read = await readJson<{ x: number; y: string }>(fp);
    expect(read).toEqual({ x: 1, y: 'two' });
  });

  it('leaves no .tmp residue after a successful write', async () => {
    sandbox = await createSandbox('atomic-tmp');
    const fp = path.join(sandbox.libraryRoot, 'b.json');
    await atomicWriteJson(fp, { ok: true });
    const entries = await fs.readdir(sandbox.libraryRoot);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('produces a valid file under simulated concurrent writers', async () => {
    sandbox = await createSandbox('atomic-concurrent');
    const fp = path.join(sandbox.libraryRoot, 'concurrent.json');
    const writers: Promise<void>[] = [];
    for (let i = 0; i < 50; i += 1) {
      writers.push(atomicWriteJson(fp, { value: i, marker: 'write-' + i }));
    }
    await Promise.all(writers);
    // Whatever the final value is, the file must be valid JSON matching the shape.
    const read = await readJson<{ value: number; marker: string }>(fp);
    expect(typeof read.value).toBe('number');
    expect(read.marker).toMatch(/^write-\d+$/);
    // No leftover .tmp files
    const entries = await fs.readdir(sandbox.libraryRoot);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});
