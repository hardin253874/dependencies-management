import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import { walkProject } from '@/core/graph/walk';
import { createResolverContext, type ResolveOutcome, type ResolverContext } from '@/core/graph/resolve';
import type { EdgeKind } from '@/core/graph/types';

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox('graph-resolve');
});

afterEach(async () => {
  await sandbox.dispose();
});

async function contextFor(fixture: string): Promise<{ ctx: ResolverContext; projectRoot: string }> {
  const { projectRoot } = await copyGraphFixture(sandbox, fixture);
  const files = await walkProject({ projectRoot });
  return { ctx: await createResolverContext({ projectRoot, files }), projectRoot };
}

type Expect = Partial<ResolveOutcome>;

function check(ctx: ResolverContext, fromFile: string, specifier: string | null, expected: Expect, kind: EdgeKind = 'static') {
  const out = ctx.resolve({ fromFile, specifier, kind });
  expect(out, `${fromFile} → ${String(specifier)}`).toMatchObject(expected);
}

describe('resolver (3a.5)', () => {
  it('identifies itself as oxc-resolver 11.24.2', async () => {
    const { ctx } = await contextFor('index-files');
    expect(ctx.id).toBe('oxc-resolver@11.24.2');
  });

  it('paths-alias: tsconfig paths + baseUrl through a 2-level extends chain (one from node_modules)', async () => {
    const { ctx } = await contextFor('paths-alias');
    const from = 'src/components/Clock.tsx';
    check(ctx, from, '@/utils/date', { resolution: 'resolved', toFile: 'src/utils/date.ts', confidence: 'high', alias: null });
    check(ctx, from, '~utils/x', { resolution: 'resolved', toFile: 'src/utils/x.ts', confidence: 'high' });
    check(ctx, from, 'src/utils/y', { resolution: 'resolved', toFile: 'src/utils/y.ts', confidence: 'high' });
    check(ctx, from, '@/nope', { resolution: 'unresolved', unresolvedReason: 'not-found', packageName: null });
    check(ctx, 'src/utils/date.ts', 'dayjs', { resolution: 'external', packageName: 'dayjs', confidence: 'medium', subpath: null });
  });

  it('paths-alias: the config hash covers the extends chain', async () => {
    const { ctx, projectRoot } = await contextFor('paths-alias');
    const before = ctx.configHash;
    await writeProjectFile(projectRoot, 'node_modules/@tsconfig/base/tsconfig.json', '{ "compilerOptions": { "strict": false } }\n');
    const files = await walkProject({ projectRoot });
    const after = (await createResolverContext({ projectRoot, files })).configHash;
    expect(after).not.toBe(before);
    expect(ctx.configFiles).toEqual(
      expect.arrayContaining(['tsconfig.json', 'tsconfig.paths.json', 'node_modules/@tsconfig/base/tsconfig.json', 'package.json'])
    );
  });

  it('webpack-alias: object-literal aliases, path.resolve/join forms, exact `$` key, one unreadable alias', async () => {
    const { ctx } = await contextFor('webpack-alias');
    const from = 'src/app.js';
    check(ctx, from, 'Components/Button', { resolution: 'resolved', toFile: 'src/components/Button.js', confidence: 'medium', alias: 'Components' });
    check(ctx, from, '@shared/theme', { resolution: 'resolved', toFile: 'shared/theme.js', confidence: 'medium', alias: '@shared' });
    check(ctx, from, 'Utils', { resolution: 'resolved', toFile: 'src/utils/index.js', confidence: 'medium', alias: 'Utils$' });
    check(ctx, from, 'Dynamic/thing', { resolution: 'unresolved', unresolvedReason: 'alias-unreadable', alias: 'Dynamic' });
    check(ctx, from, 'react', { resolution: 'external', packageName: 'react', confidence: 'medium' });
    expect(ctx.unreadableAliases).toEqual(['Dynamic']);
  });

  it('vite-alias: array form, fileURLToPath(new URL()) form, regex find is unreadable', async () => {
    const { ctx } = await contextFor('vite-alias');
    const from = 'src/main.ts';
    check(ctx, from, '@/store', { resolution: 'resolved', toFile: 'src/store/index.ts', confidence: 'medium', alias: '@' });
    check(ctx, from, 'assets/logo', { resolution: 'resolved', toFile: 'src/assets/logo.ts', confidence: 'medium', alias: 'assets' });
    check(ctx, from, '~lodash/chunk', { resolution: 'unresolved', unresolvedReason: 'alias-unreadable', alias: '/^~(.*)$/' });
    check(ctx, 'vite.config.ts', 'node:url', { resolution: 'builtin', packageName: null });
    check(ctx, 'vite.config.ts', 'vite', { resolution: 'external', packageName: 'vite' });
  });

  it('next-alias: webpack(config) assignment forms', async () => {
    const { ctx } = await contextFor('next-alias');
    check(ctx, 'pages/index.js', '@lib/api', { resolution: 'resolved', toFile: 'lib/api.js', confidence: 'medium', alias: '@lib' });
    check(ctx, 'pages/index.js', '@ui/Button', { resolution: 'resolved', toFile: 'components/ui/Button.js', confidence: 'medium', alias: '@ui' });
  });

  it('package-exports-subpath: exports conditions, subpaths, package imports (#internal)', async () => {
    const { ctx } = await contextFor('package-exports-subpath');
    const from = 'src/index.js';
    check(ctx, from, 'cond-pkg', { resolution: 'external', packageName: 'cond-pkg', subpath: null, confidence: 'high' });
    check(ctx, from, 'cond-pkg/feature', { resolution: 'external', packageName: 'cond-pkg', subpath: 'feature', confidence: 'high' });
    check(ctx, from, 'lodash/fp', { resolution: 'external', packageName: 'lodash', subpath: 'fp', confidence: 'high' });
    check(ctx, from, '#internal/a', { resolution: 'resolved', toFile: 'src/internal/a.js', confidence: 'high' });
    check(ctx, from, '#config', { resolution: 'resolved', toFile: 'src/config.node.js', confidence: 'high' });
    check(ctx, from, 'cond-pkg/not-exported', { resolution: 'external', packageName: 'cond-pkg', subpath: 'not-exported', confidence: 'medium' });
    expect(ctx.declared).toEqual(['cond-pkg', 'lodash']);
  });

  it('workspaces-monorepo: workspace packages resolve to files and keep the package', async () => {
    const { ctx } = await contextFor('workspaces-monorepo');
    const from = 'packages/app/src/main.ts';
    check(ctx, from, '@mono/ui', { resolution: 'resolved', toFile: 'packages/ui/src/index.ts', packageName: '@mono/ui', isWorkspace: true, confidence: 'high' });
    check(ctx, from, '@mono/ui/src/helper', { resolution: 'resolved', toFile: 'packages/ui/src/helper.ts', packageName: '@mono/ui', subpath: 'src/helper', isWorkspace: true });
    check(ctx, 'packages/ui/src/Button.tsx', 'react', { resolution: 'external', packageName: 'react', isWorkspace: false });
    expect(ctx.workspaces).toEqual([
      { name: '@mono/app', dir: 'packages/app' },
      { name: '@mono/ui', dir: 'packages/ui' }
    ]);
    expect(ctx.declared).toEqual(expect.arrayContaining(['typescript', 'react', '@mono/ui']));
  });

  it('index-files: index resolution, extension order, missing file', async () => {
    const { ctx } = await contextFor('index-files');
    const from = 'src/app.ts';
    check(ctx, from, './components', { resolution: 'resolved', toFile: 'src/components/index.ts', confidence: 'high' });
    check(ctx, from, './utils', { resolution: 'resolved', toFile: 'src/utils/index.js' });
    check(ctx, from, './dup', { resolution: 'resolved', toFile: 'src/dup.ts' });
    check(ctx, from, './missing', { resolution: 'unresolved', unresolvedReason: 'not-found', toFile: null });
  });

  it('cjs-esm-mix: relative with extension, builtins with and without node:, bare packages', async () => {
    const { ctx } = await contextFor('cjs-esm-mix');
    check(ctx, 'src/server.js', './util.mjs', { resolution: 'resolved', toFile: 'src/util.mjs' }, 'require');
    check(ctx, 'src/index.cjs', './server', { resolution: 'resolved', toFile: 'src/server.js' }, 'side-effect');
    check(ctx, 'src/legacy.ts', 'fs', { resolution: 'builtin', packageName: null, confidence: 'high' }, 'require');
    check(ctx, 'src/legacy.ts', 'node:path', { resolution: 'builtin' });
    check(ctx, 'src/server.js', 'express', { resolution: 'external', packageName: 'express', confidence: 'medium' }, 'require');
  });

  it('dynamic-import: literal resolves, expression is unresolved dynamic-expression', async () => {
    const { ctx } = await contextFor('dynamic-import');
    check(ctx, 'src/router.ts', './pages/Home', { resolution: 'resolved', toFile: 'src/pages/Home.tsx' }, 'dynamic-literal');
    check(ctx, 'src/router.ts', null, { resolution: 'unresolved', unresolvedReason: 'dynamic-expression' }, 'dynamic-expr');
    check(ctx, 'src/router.ts', 'lodash-es', { resolution: 'external', packageName: 'lodash-es' }, 'dynamic-literal');
  });

  it('a relative import that escapes the project root is unresolved: outside-root', async () => {
    const { ctx, projectRoot } = await contextFor('index-files');
    await writeProjectFile(projectRoot, '../sibling/x.ts', 'export const x = 1;\n');
    check(ctx, 'src/app.ts', '../../sibling/x', { resolution: 'unresolved', unresolvedReason: 'outside-root' });
  });

  it('tsconfig.json wins over jsconfig.json in the same directory', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'index-files');
    await writeProjectFile(projectRoot, 'jsconfig.json', '{ "compilerOptions": {} }\n');
    await writeProjectFile(projectRoot, 'tsconfig.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n');
    const ctx = await createResolverContext({ projectRoot, files: await walkProject({ projectRoot }) });
    check(ctx, 'src/app.ts', '@/dup', { resolution: 'resolved', toFile: 'src/dup.ts', confidence: 'high' });
  });

  it('resolves an extension-less import to a .d.ts file, as TypeScript does', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'index-files');
    await writeProjectFile(projectRoot, 'src/types/FooType.d.ts', 'export interface Foo { a: number }\n');
    const ctx = await createResolverContext({ projectRoot, files: await walkProject({ projectRoot }) });
    check(ctx, 'src/app.ts', './types/FooType', { resolution: 'resolved', toFile: 'src/types/FooType.d.ts', confidence: 'high' });
  });

  it('strips bundler query suffixes (`?react`, `?inline`) before resolving', async () => {
    const { ctx } = await contextFor('index-files');
    check(ctx, 'src/app.ts', './dup?inline', { resolution: 'resolved', toFile: 'src/dup.ts' });
    check(ctx, 'src/app.ts', './components/index.ts?raw', { resolution: 'resolved', toFile: 'src/components/index.ts' });
  });

  it('an unreadable alias on a declared package keeps the package (low); on a pseudo-package it stays unresolved', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'webpack-alias');
    await writeProjectFile(
      projectRoot,
      'webpack.config.js',
      "const root = process.env.ROOT;\nmodule.exports = { resolve: { alias: { react: root + '/node_modules/react', preact: root, Widgets: root } } };\n"
    );
    // A nested app (not a workspace) declares preact; the root package.json does not.
    await writeProjectFile(projectRoot, 'apps/legacy/package.json', '{ "name": "legacy", "dependencies": { "preact": "10.0.0" } }\n');
    const ctx = await createResolverContext({ projectRoot, files: await walkProject({ projectRoot }) });
    check(ctx, 'src/app.js', 'react', { resolution: 'external', packageName: 'react', confidence: 'low', alias: 'react' });
    check(ctx, 'src/app.js', 'preact/hooks', { resolution: 'external', packageName: 'preact', subpath: 'hooks', confidence: 'low', alias: 'preact' });
    check(ctx, 'src/app.js', 'Widgets/x', { resolution: 'unresolved', unresolvedReason: 'alias-unreadable', alias: 'Widgets' });
  });

  it('URL-like and invalid bare specifiers are unresolved, never attributed to a package', async () => {
    const { ctx } = await contextFor('index-files');
    check(ctx, 'src/app.ts', 'https://cdn.example.com/x.js', { resolution: 'unresolved', unresolvedReason: 'not-found', packageName: null });
    check(ctx, 'src/app.ts', '@/x', { resolution: 'unresolved', unresolvedReason: 'not-found', packageName: null });
  });
});
