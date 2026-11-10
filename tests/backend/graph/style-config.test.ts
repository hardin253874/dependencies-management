import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture } from '../helpers/graphFixture';
import { walkProject } from '@/core/graph/walk';
import { createResolverContext } from '@/core/graph/resolve';
import { parseStyleImports } from '@/core/graph/style';
import { extractConfigRefs } from '@/core/graph/configRefs';
import { configInfo } from '@/core/graph/configFiles';
import { babelParser } from '@/core/graph/parse';

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox('graph-style-config');
});

afterEach(async () => {
  await sandbox.dispose();
});

describe('style imports (3a.6)', () => {
  it('extracts @use/@import/@forward and node_modules url() lines, skipping remote URLs and comments', () => {
    const src = [
      "@use 'sass:math';",
      "@forward 'src/list' hide list-reset;",
      '@import "a", "b";',
      "@import url('https://fonts.googleapis.com/css?family=Roboto');",
      '@import url(~pkg/reset.css);',
      '@import (reference) "./vars.less";',
      ".x { background: url('~bootstrap/img/x.png'); mask: url(./local.svg); }",
      "// @import 'commented';",
      "/* @import 'block-commented'; */"
    ].join('\n');
    const imps = parseStyleImports(src);
    expect(imps.map((i) => [i.specifier, i.line, i.kind])).toEqual([
      ['sass:math', 1, 'style-import'],
      ['src/list', 2, 'style-import'],
      ['a', 3, 'style-import'],
      ['b', 3, 'style-import'],
      ['~pkg/reset.css', 5, 'style-import'],
      ['./vars.less', 6, 'style-import'],
      ['~bootstrap/img/x.png', 7, 'style-import']
    ]);
  });

  it('resolves the scss-bootstrap fixture with partial rules, ~ stripping, sass: builtins and interpolation', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'scss-bootstrap');
    const files = await walkProject({ projectRoot });
    const ctx = await createResolverContext({ projectRoot, files });
    const src = await fs.readFile(path.join(projectRoot, 'styles', 'main.scss'), 'utf8');
    const out = parseStyleImports(src).map((i) => ({
      spec: i.specifier,
      line: i.line,
      ...ctx.resolve({ fromFile: 'styles/main.scss', specifier: i.specifier, kind: i.kind })
    }));
    expect(out).toEqual([
      expect.objectContaining({ spec: 'sass:math', resolution: 'builtin' }),
      expect.objectContaining({ spec: './partials/mixins', resolution: 'resolved', toFile: 'styles/partials/_mixins.scss', confidence: 'medium' }),
      expect.objectContaining({ spec: '~bootstrap/scss/variables', resolution: 'external', packageName: 'bootstrap', subpath: 'scss/variables', confidence: 'medium' }),
      expect.objectContaining({ spec: 'theme/#{$theme}', resolution: 'unresolved', unresolvedReason: 'interpolated-style' }),
      expect.objectContaining({ spec: '~bootstrap/img/x.png', line: 6, resolution: 'external', packageName: 'bootstrap', confidence: 'medium' })
    ]);

    const less = await fs.readFile(path.join(projectRoot, 'styles', 'legacy.less'), 'utf8');
    const [lessImp] = parseStyleImports(less);
    expect(ctx.resolve({ fromFile: 'styles/legacy.less', specifier: lessImp!.specifier, kind: 'style-import' })).toMatchObject({
      resolution: 'resolved',
      toFile: 'styles/vars.less'
    });

    // A JS import of a stylesheet is a normal edge to the style file.
    expect(ctx.resolve({ fromFile: 'src/index.js', specifier: '../styles/main.scss', kind: 'side-effect' })).toMatchObject({
      resolution: 'resolved',
      toFile: 'styles/main.scss',
      confidence: 'high'
    });
  });

  it('a bare style specifier without a local match or installed package is an external by name', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'scss-bootstrap');
    const ctx = await createResolverContext({ projectRoot, files: await walkProject({ projectRoot }) });
    expect(ctx.resolve({ fromFile: 'styles/main.scss', specifier: 'normalize.css/normalize', kind: 'style-import' })).toMatchObject({
      resolution: 'external',
      packageName: 'normalize.css',
      confidence: 'medium'
    });
    expect(ctx.resolve({ fromFile: 'styles/main.scss', specifier: './nope', kind: 'style-import' })).toMatchObject({
      resolution: 'unresolved',
      unresolvedReason: 'not-found'
    });
  });
});

describe('config references (3a.6)', () => {
  async function refsFor(projectRoot: string, rel: string, declared: string[]) {
    const source = await fs.readFile(path.join(projectRoot, ...rel.split('/')), 'utf8');
    const info = configInfo(rel);
    if (info === null) throw new Error(`not a config file: ${rel}`);
    return extractConfigRefs({ relPath: rel, source, info, declared }).map((r) => `${r.packageName}:${r.confidence}:${r.line}`);
  }

  it('extracts the expected package references with confidences, never executing configs', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'config-refs');
    const ctx = await createResolverContext({ projectRoot, files: await walkProject({ projectRoot }) });
    const declared = ctx.declared;

    expect(await refsFor(projectRoot, '.babelrc', declared)).toEqual(['@babel/preset-env:low:2', 'babel-plugin-lodash:low:3']);
    expect(await refsFor(projectRoot, 'postcss.config.js', declared)).toEqual(['tailwindcss:medium:3', 'autoprefixer:medium:4']);
    expect(await refsFor(projectRoot, '.eslintrc.js', declared)).toEqual([
      'eslint-config-airbnb:low:2',
      'eslint-plugin-react:low:2',
      'eslint-plugin-react:low:3'
    ]);
    expect(await refsFor(projectRoot, '.eslintrc.yml', declared)).toEqual(['eslint-plugin-import:low:2']);
    expect(await refsFor(projectRoot, 'package.json', declared)).toEqual(['ts-jest:medium:20']);
    expect(await refsFor(projectRoot, 'tsconfig.json', declared)).toEqual(['@types/jest:low:3']);
    expect(await refsFor(projectRoot, 'next.config.js', declared)).toEqual([]);

    // JS configs still get their normal require/import edges.
    const nextSrc = await fs.readFile(path.join(projectRoot, 'next.config.js'), 'utf8');
    expect(babelParser.parse(nextSrc, 'next.config.js').imports.map((i) => i.specifier)).toEqual(['fs', 'path']);

    expect(existsSync(path.join(projectRoot, 'EXECUTED_MARKER'))).toBe(false);
  });

  it('expands shorthand names per tool', () => {
    const declared = ['@typescript-eslint/eslint-plugin', 'eslint-config-prettier', '@babel/plugin-transform-runtime', 'babel-preset-react-app'];
    const src = JSON.stringify(
      {
        extends: ['plugin:@typescript-eslint/recommended', 'prettier', 'eslint:recommended'],
        plugins: ['@typescript-eslint']
      },
      null,
      2
    );
    const eslint = extractConfigRefs({ relPath: '.eslintrc.json', source: src, info: { tool: 'eslint', format: 'json' }, declared });
    expect(eslint.map((r) => `${r.packageName}:${r.confidence}`)).toEqual([
      '@typescript-eslint/eslint-plugin:low',
      'eslint-config-prettier:low',
      '@typescript-eslint/eslint-plugin:low'
    ]);
    const babel = extractConfigRefs({
      relPath: 'babel.config.json',
      source: JSON.stringify({ presets: ['react-app'], plugins: ['@babel/transform-runtime', 'module:metro-react-native-babel-preset'] }),
      info: { tool: 'babel', format: 'json' },
      declared
    });
    expect(babel.map((r) => `${r.packageName}:${r.confidence}`)).toEqual([
      'babel-preset-react-app:low',
      '@babel/plugin-transform-runtime:low',
      'metro-react-native-babel-preset:low'
    ]);
  });

  it('an undeclared conventional plugin name is a low-confidence ref; an unrelated string is not', () => {
    const refs = extractConfigRefs({
      relPath: 'babel.config.js',
      source: "module.exports = { plugins: ['babel-plugin-undeclared'], comments: 'not-a-package' };",
      info: { tool: 'babel', format: 'js' },
      declared: []
    });
    expect(refs.map((r) => `${r.packageName}:${r.confidence}`)).toEqual(['babel-plugin-undeclared:low']);
  });
});
