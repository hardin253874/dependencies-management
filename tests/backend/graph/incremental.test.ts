import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import { buildGraph, GRAPH_BUILDER_ID, type BuildProgress } from '@/core/graph/build';
import { BABEL_PARSER_VERSION, BABEL_TRAVERSE_VERSION } from '@/core/graph/parse';
import { OXC_RESOLVER_VERSION } from '@/core/graph/resolve';
import { openGraphReader, openGraphWriter, GraphDbLockedError, type GraphDriver } from '@/core/graph/store';
import { dumpGraph } from '@/core/graph/dump';
import { withProjectLock } from '@/lib/storage/projectLock';

let sandbox: Sandbox;
const handles: GraphDriver[] = [];

beforeEach(async () => {
  sandbox = await createSandbox('graph-incremental');
});

afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  await sandbox.dispose();
});

const lock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

function dumpOf(dbPath: string) {
  const r = openGraphReader(dbPath);
  try {
    return dumpGraph(r);
  } finally {
    r.close();
  }
}

let bump = 0;
/** Write content and push mtime forward, so the (size, mtime) fast path cannot miss the change. */
async function edit(projectRoot: string, rel: string, content: string): Promise<void> {
  await writeProjectFile(projectRoot, rel, content);
  bump += 10;
  const t = new Date(Date.now() + bump * 1000);
  await fs.utimes(path.join(projectRoot, ...rel.split('/')), t, t);
}

/**
 * The core assertion of 3a.8: after a change, the incremental DB's dump equals
 * a fresh full build of the same tree.
 */
async function expectIncrementalEqualsFull(
  fixture: string,
  mutate: (root: string) => Promise<void>,
  expectedMode = 'incremental',
  setup?: (root: string) => Promise<void>
) {
  const { projectRoot, dbPath } = await copyGraphFixture(sandbox, fixture);
  if (setup !== undefined) await setup(projectRoot);
  await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
  await mutate(projectRoot);
  const inc = await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });
  expect(inc.mode).toBe(expectedMode);
  const freshDb = path.join(sandbox.libraryRoot, `${fixture}-fresh-${bump}`, 'graph.db');
  await buildGraph({ projectRoot, dbPath: freshDb, mode: 'full', lock });
  const a = dumpOf(dbPath);
  const b = dumpOf(freshDb);
  a.meta = a.meta!.filter((m) => !m.includes('rebuildReason'));
  b.meta = b.meta!.filter((m) => !m.includes('rebuildReason'));
  expect(a).toEqual(b);
  return inc;
}

describe('incremental rescan (3a.8): incremental == full', () => {
  it('edit a file (barrel consumer switches import path)', async () => {
    const res = await expectIncrementalEqualsFull('barrel-reexport', (root) =>
      edit(root, 'src/app/Page.tsx', "import { Button } from '../ui/Button';\nimport { debounce } from '../ui';\n\nexport const Page = () => <Button onClick={debounce(() => 1, 5)} />;\n")
    );
    expect(res.filesChanged).toBe(1);
  });

  it('add a file', async () => {
    const res = await expectIncrementalEqualsFull('wrapper-module', (root) =>
      edit(root, 'src/features/comments.ts', "import { post } from '../lib/http';\n\nexport const comment = (c: string) => post('/c', c);\n")
    );
    expect(res.filesChanged).toBe(1);
  });

  it('delete a file', async () => {
    await expectIncrementalEqualsFull('wrapper-module', (root) => fs.rm(path.join(root, 'src', 'features', 'posts.ts')));
  });

  it('rename a file (its importer becomes unresolved)', async () => {
    await expectIncrementalEqualsFull('wrapper-module', (root) =>
      fs.rename(path.join(root, 'src', 'features', 'users.ts'), path.join(root, 'src', 'features', 'people.ts'))
    );
  });

  it('change tsconfig paths (re-resolve without re-parsing sources)', async () => {
    const res = await expectIncrementalEqualsFull('paths-alias', (root) =>
      edit(
        root,
        'tsconfig.paths.json',
        JSON.stringify({ extends: '@tsconfig/base/tsconfig.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/components/*'], '~utils/*': ['src/utils/*'] } } })
      )
    );
    expect(res.filesChanged).toBe(1);
  });

  it('add a file that shadows an index file', async () => {
    await expectIncrementalEqualsFull('index-files', (root) => edit(root, 'src/utils.ts', 'export default function shadow() {}\n'));
  });

  it('change package.json dependencies (config refs re-classified)', async () => {
    await expectIncrementalEqualsFull('config-refs', async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
      delete pkg.devDependencies['eslint-plugin-react'];
      pkg.devDependencies['eslint-plugin-jsx-a11y'] = '6.8.0';
      await edit(root, 'package.json', JSON.stringify(pkg, null, 2));
    });
  });

  it('add a lockfile (external edges re-resolved only)', async () => {
    await expectIncrementalEqualsFull('package-exports-subpath', (root) =>
      edit(
        root,
        'package-lock.json',
        JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/cond-pkg': { version: '1.0.0' }, 'node_modules/lodash': { version: '4.17.21' } } })
      )
    );
  });

  // Stage 3c (3a QA m3a): `npm ci` with an unchanged lockfile still changes what external edges resolve to.
  it('install packages into node_modules without a lockfile change (externals re-resolved)', async () => {
    const inc = await expectIncrementalEqualsFull('wrapper-module', async (root) => {
      await writeProjectFile(root, 'node_modules/axios/package.json', '{ "name": "axios", "version": "1.7.0", "main": "index.js" }\n');
      await writeProjectFile(root, 'node_modules/axios/index.js', 'module.exports = {};\n');
      await writeProjectFile(root, 'node_modules/.package-lock.json', '{ "name": "wrapper-module", "lockfileVersion": 3, "packages": {} }\n');
    });
    expect(inc.filesChanged).toBe(0);
  });

  // Stage 3c (3a QA m3b): a sub-project tsconfig extending a base outside its root (per-projectDir eval builds).
  it('edit a tsconfig base that lies outside the project root (extends ../)', async () => {
    await expectIncrementalEqualsFull(
      'paths-alias',
      (root) =>
        edit(root, '../tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: './paths-alias', paths: { '#lib/*': ['./src/utils/*'] } } })),
      'incremental',
      async (root) => {
        await writeProjectFile(root, '../tsconfig.base.json', JSON.stringify({ compilerOptions: {} }));
        await writeProjectFile(root, 'tsconfig.json', JSON.stringify({ extends: '../tsconfig.base.json', include: ['src'] }));
        await writeProjectFile(root, 'src/utils/z.ts', "import { x } from '#lib/x';\nexport const z = x;\n");
      }
    );
  });

  it('a moved project root forces a full build', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const moved = path.join(path.dirname(projectRoot), 'index-files-moved');
    await fs.rename(projectRoot, moved);
    const res = await buildGraph({ projectRoot: moved, dbPath, mode: 'auto', lock });
    expect(res.mode).toBe('full');
  });

  // Stage 3c (3a QA m2): parse/resolve logic or dependency changes must invalidate an existing graph.
  it('records the builder version in meta', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const r = openGraphReader(dbPath);
    handles.push(r);
    expect(r.prepare("SELECT value FROM meta WHERE key = 'builder'").get()?.value).toBe(GRAPH_BUILDER_ID);
  });

  it('a graph written by another builder version is rebuilt in full', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const w = await openGraphWriter({ dbPath, projectRoot });
    w.db.exec("UPDATE meta SET value = 'graph@1' WHERE key = 'builder'");
    w.db.close();
    const res = await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });
    expect(res.mode).toBe('full');
  });

  it('a graph from before builder versions existed (no meta.builder) is rebuilt in full', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const w = await openGraphWriter({ dbPath, projectRoot });
    w.db.exec("DELETE FROM meta WHERE key = 'builder'");
    w.db.close();
    expect((await buildGraph({ projectRoot, dbPath, mode: 'auto', lock })).mode).toBe('full');
  });

  it('the builder id names the pinned parser, traverse and resolver versions, matching package.json and node_modules', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const installed = async (name: string) =>
      (JSON.parse(await fs.readFile(path.join(process.cwd(), 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version: string }).version;
    for (const [name, constant] of [
      ['@babel/parser', BABEL_PARSER_VERSION],
      ['@babel/traverse', BABEL_TRAVERSE_VERSION],
      ['oxc-resolver', OXC_RESOLVER_VERSION]
    ] as const) {
      expect(pkg.dependencies[name], name).toBe(constant);
      expect(await installed(name), name).toBe(constant);
      expect(GRAPH_BUILDER_ID).toContain(`${name}@${constant}`);
    }
  });

  it('auto on a missing DB is a full build', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    const res = await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });
    expect(res.mode).toBe('full');
    expect(res.rebuildReason).toBe('new');
  });
});

describe('no-change rescan (3a.8)', () => {
  it('reports 0 changed files, keeps edge row ids, only updates builtAt', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'barrel-reexport');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const r1 = openGraphReader(dbPath);
    const ids1 = r1.prepare('SELECT id, from_file, specifier FROM import_edge ORDER BY id').all();
    const builtAt1 = String(r1.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get()?.value);
    const dump1 = dumpGraph(r1);
    r1.close();

    await new Promise((r) => setTimeout(r, 5));
    const res = await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });
    expect(res.mode).toBe('incremental');
    expect(res.filesChanged).toBe(0);

    const r2 = openGraphReader(dbPath);
    handles.push(r2);
    expect(r2.prepare('SELECT id, from_file, specifier FROM import_edge ORDER BY id').all()).toEqual(ids1);
    expect(String(r2.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get()?.value)).not.toBe(builtAt1);
    expect(dumpGraph(r2)).toEqual(dump1);
  });

  it('a touched-but-identical file is not re-parsed (hash decides)', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const rel = 'src/lib/http.ts';
    await edit(projectRoot, rel, await fs.readFile(path.join(projectRoot, rel), 'utf8'));
    const res = await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });
    expect(res.filesChanged).toBe(0);
  });
});

describe('single writer (3a.8)', () => {
  it('two builds through the same lock are serialized', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    const events: string[] = [];
    const run = (name: string) =>
      buildGraph({
        projectRoot,
        dbPath,
        mode: 'full',
        lockKey: 'graph:serial-test',
        lock: (k, fn) => withProjectLock(k, fn),
        onProgress: (p: BuildProgress) => {
          if (p.phase === 'walk' || (p.phase === 'write' && p.current === p.total && p.total > 0)) events.push(`${name}:${p.phase}`);
        }
      });
    await Promise.all([run('a'), run('b')]);
    expect(events).toEqual(['a:walk', 'a:write', 'b:walk', 'b:write']);
  });

  it('a reader querying during an incremental write sees a consistent snapshot', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const r = openGraphReader(dbPath);
    handles.push(r);
    const before = JSON.stringify(dumpGraph(r));
    await edit(projectRoot, 'src/features/extra.ts', "import { get } from '../lib/http';\nexport const extra = () => get('/x');\n");
    const seen: boolean[] = [];
    await buildGraph({
      projectRoot,
      dbPath,
      mode: 'auto',
      lock,
      onProgress: (p) => {
        if (p.phase === 'write') seen.push(JSON.stringify(dumpGraph(r)) === before);
      }
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(JSON.stringify(dumpGraph(r))).not.toBe(before);
  });

  it('another connection holding the write lock makes the build fail with GraphDbLockedError, DB intact', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const before = dumpOf(dbPath);
    const other = await openGraphWriter({ dbPath, projectRoot, busyTimeoutMs: 50 });
    handles.push(other.db);
    other.db.exec('BEGIN IMMEDIATE');
    try {
      await expect(buildGraph({ projectRoot, dbPath, mode: 'full', lock, busyTimeoutMs: 100 })).rejects.toBeInstanceOf(GraphDbLockedError);
    } finally {
      other.db.exec('ROLLBACK');
    }
    expect(dumpOf(dbPath)).toEqual(before);
  });
});
