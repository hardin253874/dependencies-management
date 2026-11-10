/**
 * Graph predictor (V2_STAGE3_SPEC 3b-B.2): sandbox copies of the graph
 * fixtures act as clones under an injected eval cache dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import {
  graphDbPath,
  GraphDbPathError,
  graphForCase,
  predictV2Graph,
  projectDirSlug,
  type ProjectDirGraph
} from '../../../eval/lib/predict-graph';

let sandbox: Sandbox;
let cacheDir: string;

/** Copies a fixture to `<cache>/<caseId>/<sub>` so the clone lives in the cache like a real case. */
async function cloneFixture(name: string, caseId: string, sub = '.'): Promise<string> {
  const { projectRoot } = await copyGraphFixture(sandbox, name, `${caseId}-src`);
  const cloneDir = path.join(cacheDir, caseId);
  await fs.cp(projectRoot, path.join(cloneDir, sub), { recursive: true });
  return cloneDir;
}

async function graphOf(name: string, packages: string[]): Promise<ProjectDirGraph> {
  const cloneDir = await cloneFixture(name, name);
  const [g] = await graphForCase({ cacheDir, cloneDir, caseId: name, projectDirs: ['.'], packagesFor: () => packages });
  return g!;
}

beforeAll(async () => {
  sandbox = await createSandbox('graph-predict');
  cacheDir = await sandbox.scratch('eval-cache');
});

afterAll(async () => {
  await sandbox.dispose();
});

describe('graphForCase', () => {
  it('barrel-reexport: direct, reexport and wrapper sets are separate', async () => {
    const g = await graphOf('barrel-reexport', ['antd', 'lodash']);
    expect(g.packages.antd).toMatchObject({
      direct: ['src/ui/Button.tsx'],
      reexport: ['src/app/Local.tsx', 'src/app/Ns.tsx', 'src/app/Page.tsx'],
      wrapper: ['src/ui/index.ts'],
      aliasOnly: [],
      isWorkspace: false
    });
    expect(g.packages.lodash!.direct).toEqual(['src/ui/index.ts']);
    expect(g.unresolved.totalEdges).toBeGreaterThan(0);
    expect(g.files).toBeGreaterThan(0);
    await expect(fs.stat(graphDbPath(cacheDir, 'barrel-reexport', '.'))).resolves.toBeTruthy();
  }, 30_000);

  it('wrapper-module: wrapper consumers are reported, not scored as direct', async () => {
    const g = await graphOf('wrapper-module', ['axios']);
    expect(g.packages.axios).toMatchObject({
      direct: ['src/lib/http.ts'],
      reexport: [],
      wrapper: ['src/components/Avatar.tsx', 'src/features/posts.ts', 'src/features/users.ts']
    });
  }, 30_000);

  it('a hit only through a bundler alias to another name is alias-only; a same-name alias is direct', async () => {
    const cloneDir = path.join(cacheDir, 'alias-only');
    await writeProjectFile(cloneDir, 'package.json', JSON.stringify({ dependencies: { antd: '5.0.0', react: '18.3.1' } }));
    await writeProjectFile(
      cloneDir,
      'webpack.config.js',
      "const path = require('path');\nmodule.exports = { resolve: { alias: { '@ui': 'antd', react: path.resolve(__dirname, 'node_modules/react') } } };\n"
    );
    await writeProjectFile(cloneDir, 'node_modules/react/package.json', JSON.stringify({ name: 'react', version: '18.3.1', main: 'index.js' }));
    await writeProjectFile(cloneDir, 'node_modules/react/index.js', 'module.exports = {};\n');
    await writeProjectFile(cloneDir, 'src/a.js', "import { Button } from '@ui';\nimport React from 'react';\nexport const A = [Button, React];\n");
    const [g] = await graphForCase({ cacheDir, cloneDir, caseId: 'alias-only', projectDirs: ['.'], packagesFor: () => ['antd', 'react'] });
    expect(g!.packages.antd).toMatchObject({ direct: [], aliasOnly: ['src/a.js'] });
    expect(g!.packages.react).toMatchObject({ direct: ['src/a.js'], aliasOnly: [] });
  }, 30_000);

  it('workspaces-monorepo: a workspace package is flagged', async () => {
    const g = await graphOf('workspaces-monorepo', ['@mono/ui', 'react']);
    expect(g.packages['@mono/ui']!.isWorkspace).toBe(true);
    expect(g.packages.react!.isWorkspace).toBe(false);
  }, 30_000);

  it('refuses a DB path inside the clone', async () => {
    const cloneDir = await cloneFixture('paths-alias', 'inside');
    // cacheDir = the clone itself → <clone>/_graph/... lies inside it.
    await expect(
      graphForCase({ cacheDir: cloneDir, cloneDir, caseId: 'inside', projectDirs: ['.'], packagesFor: () => ['dayjs'] })
    ).rejects.toBeInstanceOf(GraphDbPathError);
    await expect(fs.stat(path.join(cloneDir, '_graph'))).rejects.toThrow();
  }, 30_000);

  it('projectDirSlug: root and nested dirs', () => {
    expect(projectDirSlug('.')).toBe('root');
    expect(projectDirSlug('packages/app/')).toBe('packages__app');
  });
});

describe('predictV2Graph (run --predictor v2-graph)', () => {
  it('predicts direct ∪ reexport ∪ wrapper per phase, prefixed with the projectDir', async () => {
    const cloneDir = await cloneFixture('barrel-reexport', 'v2-run', 'web');
    const prediction = await predictV2Graph(
      {
        id: 'v2-run',
        projectDirs: ['web'],
        phases: [
          { id: 'main', toCommit: 'b'.repeat(40), packages: [{ name: 'antd', from: '4.0.0', to: '5.0.0' }] },
          { id: 'none', toCommit: 'c'.repeat(40), packages: [{ name: 'not-used', from: '1.0.0', to: '2.0.0' }] }
        ]
      },
      cloneDir,
      cacheDir
    );
    expect(prediction.byPhase.get('main')).toEqual([
      'web/src/app/Local.tsx',
      'web/src/app/Ns.tsx',
      'web/src/app/Page.tsx',
      'web/src/ui/Button.tsx',
      'web/src/ui/index.ts'
    ]);
    expect(prediction.byPhase.get('none')).toEqual([]);
    expect(prediction.filesScanned).toBeGreaterThan(0);
  }, 30_000);
});
