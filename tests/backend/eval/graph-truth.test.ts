/**
 * TypeScript ground truth for "files that use package X" (V2_STAGE3_SPEC
 * 3b-B.1). Runs on sandbox copies of the graph fixtures; the committed
 * fixture tree is never touched (checked by a content snapshot).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, GRAPH_FIXTURES_ROOT, writeProjectFile } from '../helpers/graphFixture';
import {
  buildProjectDirTruth,
  createTsResolver,
  loadOrBuildCaseTruth,
  packageNameOf,
  truthCachePath,
  walkTruthFiles,
  type ProjectDirTruth
} from '../../../eval/lib/graph-truth';

const FIXTURES = ['paths-alias', 'barrel-reexport', 'wrapper-module', 'cjs-esm-mix'] as const;

let sandbox: Sandbox;
const roots: Record<string, string> = {};
const truths: Record<string, ProjectDirTruth> = {};

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = createHash('sha1').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(root);
  return out;
}

const committedBefore: Record<string, Record<string, string>> = {};
const copiesBefore: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  sandbox = await createSandbox('graph-truth');
  for (const name of FIXTURES) {
    committedBefore[name] = await snapshotTree(path.join(GRAPH_FIXTURES_ROOT, name));
    const { projectRoot } = await copyGraphFixture(sandbox, name);
    roots[name] = projectRoot;
    copiesBefore[name] = await snapshotTree(projectRoot);
    truths[name] = await buildProjectDirTruth({ projectRoot, projectDir: '.' });
  }
}, 60_000);

afterAll(async () => {
  await sandbox.dispose();
});

describe('direct + reexport truth on the graph fixtures', () => {
  it('paths-alias: tsconfig paths/baseUrl resolve to project files; a missing alias is not a package', () => {
    const t = truths['paths-alias']!;
    expect(t.packages).toEqual({ dayjs: { direct: ['src/utils/date.ts'], reexport: [] } });
    expect(t.reexportTruth).toBe('ok');
  });

  it('barrel-reexport: named, export * and namespace chains end in the package', () => {
    expect(truths['barrel-reexport']!.packages).toEqual({
      antd: { direct: ['src/ui/Button.tsx'], reexport: ['src/app/Local.tsx', 'src/app/Ns.tsx', 'src/app/Page.tsx'] },
      lodash: { direct: ['src/ui/index.ts'], reexport: ['src/app/Ns.tsx', 'src/app/Search.tsx'] }
    });
  });

  it('wrapper-module: importers of a wrapper are not package users', () => {
    expect(truths['wrapper-module']!.packages).toEqual({ axios: { direct: ['src/lib/http.ts'], reexport: [] } });
  });

  it('cjs-esm-mix: require and import attribute packages; builtins and node: are not packages', () => {
    expect(truths['cjs-esm-mix']!.packages).toEqual({
      chalk: { direct: ['src/util.mjs'], reexport: [] },
      express: { direct: ['src/server.js'], reexport: [] },
      lodash: { direct: ['src/server.js'], reexport: [] }
    });
  });

  it('leaves the committed fixtures and the sandbox copies unchanged', async () => {
    for (const name of FIXTURES) {
      expect(await snapshotTree(path.join(GRAPH_FIXTURES_ROOT, name))).toEqual(committedBefore[name]);
      expect(await snapshotTree(roots[name]!)).toEqual(copiesBefore[name]);
    }
  });
});

describe('walk, resolution rules and the time box', () => {
  it('never lists .env* files, minified files or ignored dirs', async () => {
    const root = await sandbox.scratch('walk-rules');
    await writeProjectFile(root, 'src/a.ts', "import x from 'lodash';\n");
    await writeProjectFile(root, '.env.ts', "import x from 'lodash';\n");
    await writeProjectFile(root, 'src/.env.local.js', "require('lodash');\n");
    await writeProjectFile(root, 'src/vendor.min.js', "require('lodash');\n");
    await writeProjectFile(root, 'node_modules/x/index.js', "require('lodash');\n");
    await writeProjectFile(root, 'dist/out.js', "require('lodash');\n");
    expect(await walkTruthFiles(root)).toEqual(['src/a.ts']);
  });

  it('a declared npm polyfill named like a builtin is a package; undeclared it is a builtin', async () => {
    const root = await sandbox.scratch('builtin-rule');
    await writeProjectFile(root, 'package.json', JSON.stringify({ dependencies: { buffer: '6.0.3' } }));
    await writeProjectFile(root, 'src/a.ts', "import { Buffer } from 'buffer';\nimport fs from 'fs';\nimport p from 'node:path';\n");
    const t = await buildProjectDirTruth({ projectRoot: root, projectDir: '.' });
    expect(Object.keys(t.packages)).toEqual(['buffer']);
  });

  it('solution-style tsconfig: the referenced config that includes the file supplies its paths', async () => {
    const root = await sandbox.scratch('solution-config');
    await writeProjectFile(root, 'tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }));
    await writeProjectFile(root, 'tsconfig.app.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }));
    await writeProjectFile(root, 'tsconfig.node.json', JSON.stringify({ compilerOptions: {}, include: ['vite.config.ts'] }));
    await writeProjectFile(root, 'src/i18n.ts', "import i18n from 'i18next';\nexport default i18n;\n");
    await writeProjectFile(root, 'src/page.ts', "import i18n from '@/i18n';\nexport const t = i18n;\n");
    const t = await buildProjectDirTruth({ projectRoot: root, projectDir: '.' });
    expect(t.packages).toEqual({ i18next: { direct: ['src/i18n.ts'], reexport: ['src/page.ts'] } });
  });

  it('resolver: relative miss, outside-root and bare-name attribution', async () => {
    const root = await sandbox.scratch('resolver-kinds');
    await writeProjectFile(root, 'src/a.ts', '');
    const r = createTsResolver(root);
    const from = path.join(root, 'src', 'a.ts');
    expect(r.resolve(from, './missing')).toEqual({ kind: 'unresolved', relative: true });
    expect(r.resolve(from, 'lodash/fp')).toEqual({ kind: 'package', name: 'lodash', byName: true });
    expect(r.resolve(from, 'node:fs')).toEqual({ kind: 'builtin' });
    expect(r.resolve(from, './a')).toMatchObject({ kind: 'file', rel: 'src/a.ts' });
  });

  it('packageNameOf: scoped, subpath and invalid names', () => {
    expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageNameOf('lodash/debounce')).toBe('lodash');
    expect(packageNameOf('@/utils/x')).toBeNull();
    expect(packageNameOf('#internal')).toBeNull();
  });

  it('time box exceeded: reexport truth is unavailable, direct truth stays', async () => {
    const t = await buildProjectDirTruth({ projectRoot: roots['barrel-reexport']!, projectDir: '.', reexportTimeoutMs: -1 });
    expect(t.reexportTruth).toBe('unavailable');
    expect(t.packages.antd).toEqual({ direct: ['src/ui/Button.tsx'], reexport: [] });
  });
});

describe('case truth cache', () => {
  it('caches under <cache>/_graph-truth and reuses the file; refuses a clone outside the cache', async () => {
    const cacheDir = await sandbox.scratch('eval-cache');
    const cloneDir = path.join(cacheDir, 'case-a');
    await fs.cp(roots['wrapper-module']!, cloneDir, { recursive: true });
    const opts = { cacheDir, cloneDir, caseId: 'case-a', baseCommit: 'a'.repeat(40), projectDirs: ['.'] };
    const first = await loadOrBuildCaseTruth(opts);
    expect(first.cached).toBe(false);
    await expect(fs.stat(truthCachePath(cacheDir, 'case-a', 'a'.repeat(40)))).resolves.toBeTruthy();
    const second = await loadOrBuildCaseTruth(opts);
    expect(second.cached).toBe(true);
    expect(second.truth.projectDirs[0]!.packages).toEqual(first.truth.projectDirs[0]!.packages);
    await expect(loadOrBuildCaseTruth({ ...opts, cloneDir: roots['wrapper-module']! })).rejects.toThrow(/not under the eval cache/);
  });
});
