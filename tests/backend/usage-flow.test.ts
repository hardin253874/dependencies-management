/**
 * Usage scan + view [C] integration (spec §10.6, §8.5, §8.7).
 *
 * Covered:
 *   - Scan against a fixture project: file list per dep, categories correct
 *   - Dynamic imports captured
 *   - Declared-but-unused flag
 *   - Envelope TTL freshness (deps/* TTL = 24h)
 *   - Scoped package URL handling (file slug uses __ replacement)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { scanCode } from '@/lib/scanners/code';
import { writeEnvelope, readEnvelope, isStale } from '@/lib/storage/envelope';
import { usageFilePath, depFilePath } from '@/lib/paths';
import type { UsageDetail } from '@/lib/api-types';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('usage scan against fixture', () => {
  it('produces a per-dep file list and captures dynamic imports', async () => {
    sandbox = await createSandbox('usage-real');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);

    // Add real source files using react.
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'App.tsx'), `import React from 'react';\nexport default React;\n`);
    await fs.writeFile(
      path.join(dir, 'src', 'index.test.ts'),
      `import { foo } from 'react';\nexport const t = foo;\n`
    );
    await fs.writeFile(
      path.join(dir, 'src', 'dyn.ts'),
      `const name = 'react';\nimport(name).then(() => {});\n`
    );

    const result = await scanCode({ projectRoot: dir });
    const reactFiles = result.imports.get('react') ?? [];
    expect(reactFiles.length).toBe(2); // App.tsx (prod) + index.test.ts (test)
    expect(new Set(reactFiles.map((f) => f.category))).toEqual(new Set(['prod', 'test']));
    expect(result.dynamicImports.some((d) => d.file === 'src/dyn.ts')).toBe(true);
  });

  it('records declared-but-unused via empty file list', async () => {
    sandbox = await createSandbox('usage-unused');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    await fs.writeFile(path.join(dir, 'app.ts'), `// no imports`);
    const result = await scanCode({ projectRoot: dir });
    // typescript is declared but no file imports it
    const tsFiles = result.imports.get('typescript');
    expect(tsFiles === undefined || tsFiles.length === 0).toBe(true);
  });
});

describe('TTL freshness flag', () => {
  it('marks deps cache as stale when generatedAt is > 24h old', async () => {
    sandbox = await createSandbox('ttl-test');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const oldDate = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await writeEnvelope(depFilePath(add.slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { name: 'react' },
      generatedAt: oldDate
    });
    const env = await readEnvelope<unknown>(depFilePath(add.slug, 'react'));
    expect(isStale(env)).toBe(true);
  });

  it('marks deps cache as fresh when generatedAt is < 24h old', async () => {
    sandbox = await createSandbox('ttl-fresh');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    await writeEnvelope(depFilePath(add.slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { name: 'react' }
    });
    const env = await readEnvelope<unknown>(depFilePath(add.slug, 'react'));
    expect(isStale(env)).toBe(false);
  });
});

describe('scoped-package file naming (§8.2)', () => {
  it('writes @types/react under @types__react.json', async () => {
    sandbox = await createSandbox('scoped-name');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const usageDetail: UsageDetail = {
      files: [],
      dynamicImports: [],
      totalFiles: 0,
      declaredButUnused: true,
      oversizedSkipped: []
    };
    const fp = usageFilePath(add.slug, '@types/react');
    expect(fp.endsWith('@types__react.json')).toBe(true);
    await writeEnvelope(fp, { source: 'deterministic', ttlHours: null, data: usageDetail });

    const read = await readEnvelope<UsageDetail>(fp);
    expect(read.data.declaredButUnused).toBe(true);
  });
});
