/**
 * V2_STAGE3_SPEC 3b-A.2: `usageFromGraph` vs the v1 `scanCode → UsageDetail`
 * mapping the three routes used to inline.
 *
 * On v1-shaped inputs (no aliases, no barrels) the payloads must be equal.
 * Lists are compared sorted, because v1's order depends on parse-completion
 * order. The documented, intended differences each have their own test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { copyGraphFixture, writeProjectFile } from './helpers/graphFixture';
import { scanCode } from '@/lib/scanners/code';
import { refreshProjectGraph } from '@/lib/graph/graphService';
import { closeGraphReaders, getGraphReader } from '@/lib/graph/readerCache';
import { usageFromGraph } from '@/lib/graph/usageFromGraph';
import type { UsageDetail } from '@/lib/api-types';

let sandbox: Sandbox | undefined;
const SLUG = 'parity';

afterEach(async () => {
  closeGraphReaders(SLUG);
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

/** The mapping the three routes inlined before Stage 3b (kept here as the oracle). */
async function v1Usage(projectRoot: string, name: string): Promise<UsageDetail> {
  const scan = await scanCode({ projectRoot });
  const filesForName = scan.imports.get(name) ?? [];
  return {
    files: filesForName.map((f) => ({
      path: f.path,
      pathHash: f.pathHash,
      category: f.category,
      importStatements: f.importStatements,
      importCount: f.importStatements.length
    })),
    dynamicImports: scan.dynamicImports,
    totalFiles: filesForName.length,
    declaredButUnused: filesForName.length === 0,
    oversizedSkipped: scan.oversizedSkipped
  };
}

async function graphUsage(projectRoot: string, name: string): Promise<UsageDetail> {
  await refreshProjectGraph({ slug: SLUG, projectRoot });
  return usageFromGraph(getGraphReader(SLUG), name);
}

function normalise(d: UsageDetail): UsageDetail {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ...d,
    files: [...d.files]
      .map((f) => ({ ...f, importStatements: [...f.importStatements].sort(cmp) }))
      .sort((a, b) => cmp(a.path, b.path)),
    dynamicImports: [...d.dynamicImports].sort((a, b) => cmp(a.file, b.file) || a.line - b.line),
    oversizedSkipped: [...d.oversizedSkipped].sort((a, b) => cmp(a.path, b.path))
  };
}

async function expectParity(projectRoot: string, names: string[]): Promise<void> {
  for (const name of names) {
    const v1 = normalise(await v1Usage(projectRoot, name));
    const v2 = normalise(await graphUsage(projectRoot, name));
    expect(v2, `package ${name}`).toEqual(v1);
  }
}

async function project(name: string): Promise<string> {
  sandbox = await createSandbox(`parity-${name}`);
  return sandbox.scratch(name);
}

describe('usageFromGraph parity with the v1 scanCode mapping', () => {
  it('groups imports per package and keeps categories (code-scan "happy" + usage-flow scenario)', async () => {
    const dir = await project('happy');
    await createSmallNpmProject(dir);
    await writeProjectFile(dir, 'app.tsx', `import React from 'react';\nimport ReactDOM from 'react-dom';\nimport { useState } from 'react';\n`);
    await writeProjectFile(dir, 'index.ts', `import React from 'react';\n`);
    await writeProjectFile(dir, 'src/App.tsx', `import React from 'react';\nexport default React;\n`);
    await writeProjectFile(dir, 'src/index.test.ts', `import { foo } from 'react';\nexport const t = foo;\n`);
    await expectParity(dir, ['react', 'react-dom', 'typescript', 'not-used-anywhere']);
  });

  it('matches on require, side-effect, type-only and export-from imports', async () => {
    const dir = await project('kinds');
    await writeProjectFile(dir, 'a.js', `const _ = require('lodash');\nrequire('polyfill');\n`);
    await writeProjectFile(dir, 'b.ts', `import type { Foo } from 'lodash';\nexport * from 'lodash';\nexport { map } from 'lodash';\n`);
    await writeProjectFile(dir, 'c.mjs', `import('lodash').then(() => {});\n`);
    await expectParity(dir, ['lodash', 'polyfill']);
  });

  it('skips bake-in folders, .gitignore and minified bundles the same way', async () => {
    const dir = await project('skips');
    await writeProjectFile(dir, 'node_modules/foo/index.js', `require('victim')`);
    await writeProjectFile(dir, '.next/cache.js', `require('victim')`);
    await writeProjectFile(dir, 'dist/bundle.js', `require('victim')`);
    await writeProjectFile(dir, '.gitignore', `legacy/\n`);
    await writeProjectFile(dir, 'legacy/old.js', `require('victim')`);
    await writeProjectFile(dir, 'bundle.min.js', `require('victim')`);
    await writeProjectFile(dir, 'src.ts', `import 'real';`);
    await expectParity(dir, ['victim', 'real']);
  });

  it('records oversized files and dynamic imports the same way', async () => {
    const dir = await project('oversize-dyn');
    await fs.writeFile(path.join(dir, 'huge.ts'), 'x'.repeat(3 * 1024 * 1024));
    await writeProjectFile(dir, 'small.ts', `import 'react';`);
    await writeProjectFile(dir, 'dyn.ts', `const m = 'foo';\nconst dyn = require(m);\nimport(m).then(() => {});\n`);
    await expectParity(dir, ['react']);
  });

  it('tags test / story / config / prod categories the same way', async () => {
    const dir = await project('categories');
    await writeProjectFile(dir, '__tests__/a.ts', `import 'react';`);
    await writeProjectFile(dir, 'b.stories.tsx', `import 'react';`);
    await writeProjectFile(dir, 'vite.config.ts', `import 'react';`);
    await writeProjectFile(dir, 'main.ts', `import 'react';`);
    await expectParity(dir, ['react']);
  });
});

describe('usageFromGraph intended differences from v1', () => {
  it('lists statements in source order and dynamic imports in path/line order', async () => {
    const dir = await project('order');
    await writeProjectFile(dir, 'a.ts', `import a from 'pkg';\nimport { b } from 'pkg';\nconst c = require('pkg');\n`);
    await writeProjectFile(dir, 'b.ts', `import(x);\nrequire(y);\n`);
    const usage = await graphUsage(dir, 'pkg');
    expect(usage.files[0]?.importStatements).toEqual([`import a from 'pkg';`, `import { b } from 'pkg';`, `const c = require('pkg');`]);
    expect(usage.dynamicImports.map((d) => `${d.file}:${d.line}`)).toEqual(['b.ts:1', 'b.ts:2']);
  });

  it('does not report a tsconfig paths alias (@/utils/x) as a package', async () => {
    sandbox = await createSandbox('parity-alias');
    const { projectRoot } = await copyGraphFixture(sandbox, 'paths-alias');
    await writeProjectFile(projectRoot, 'src/uses-alias.ts', `import { x } from '@/utils/x';\nexport const y = x;\n`);
    const v1 = await v1Usage(projectRoot, '@/utils');
    expect(v1.files.map((f) => f.path)).toContain('src/uses-alias.ts');
    const v2 = await graphUsage(projectRoot, '@/utils');
    expect(v2.files).toEqual([]);
    expect(v2.declaredButUnused).toBe(true);
  });

  it('adds a consumer of a barrel re-export of lodash with the barrel import as its statement', async () => {
    const dir = await project('barrel');
    await writeProjectFile(dir, 'package.json', JSON.stringify({ name: 'barrel', dependencies: { lodash: '^4.17.21' } }));
    await writeProjectFile(dir, 'src/utils/index.ts', `export { debounce } from 'lodash';\n`);
    await writeProjectFile(dir, 'src/app.ts', `import { debounce } from './utils';\nexport const run = debounce(() => 1, 10);\n`);

    const v1 = await v1Usage(dir, 'lodash');
    expect(v1.files.map((f) => f.path)).toEqual(['src/utils/index.ts']);

    const v2 = await graphUsage(dir, 'lodash');
    expect(v2.files.map((f) => f.path)).toEqual(['src/app.ts', 'src/utils/index.ts']);
    const app = v2.files.find((f) => f.path === 'src/app.ts');
    expect(app?.importStatements).toEqual([`import { debounce } from './utils';`]);
    expect(app?.importCount).toBe(1);
    expect(app?.category).toBe('prod');
  });

  it('keeps wrapper consumers, style imports and config refs out of [C]', async () => {
    sandbox = await createSandbox('parity-wrapper');
    const { projectRoot } = await copyGraphFixture(sandbox, 'wrapper-module');
    const v2 = await graphUsage(projectRoot, 'axios');
    expect(v2.files.map((f) => f.path)).toEqual(['src/lib/http.ts']);

    const scss = await copyGraphFixture(sandbox, 'scss-bootstrap', 'scss');
    closeGraphReaders(SLUG);
    await refreshProjectGraph({ slug: 'parity-scss', projectRoot: scss.projectRoot });
    try {
      const style = usageFromGraph(getGraphReader('parity-scss'), 'bootstrap');
      expect(style.files.every((f) => /\.(?:[cm]?[jt]sx?|[cm]ts)$/.test(f.path))).toBe(true);
    } finally {
      closeGraphReaders('parity-scss');
    }
  });
});
