/**
 * Code scanner unit tests (spec §10.6).
 *
 * Covered:
 *   - Happy path: static imports + requires
 *   - Dynamic imports captured into dynamicImports
 *   - Skipped folders (bake-in + .gitignore)
 *   - 2MB cap → oversizedSkipped
 *   - .min. heuristic
 *   - Category tagging (test / story / config / prod)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { scanCode, categorizeFile, parseImports, packageNameFromSpecifier, isParseable } from '@/lib/scanners/code';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('parseImports (unit)', () => {
  it('captures static ES module imports', () => {
    const src = `import React from 'react';\nimport { foo } from '@scope/pkg';\nimport './local';\n`;
    const result = parseImports(src, 'src/x.ts');
    expect(result.staticImports.map((s) => s.packageName).sort()).toEqual(['@scope/pkg', 'react']);
    expect(result.dynamicImports.length).toBe(0);
  });

  it('captures CommonJS requires with string literals', () => {
    const src = `const lodash = require('lodash');\nconst foo = require('./foo');\n`;
    const result = parseImports(src, 'src/x.js');
    expect(result.staticImports.map((s) => s.packageName)).toEqual(['lodash']);
  });

  it('captures dynamic require(variable) into dynamicImports', () => {
    const src = `const modName = 'foo';\nconst dyn = require(modName);\n`;
    const result = parseImports(src, 'src/dyn.ts');
    expect(result.staticImports.length).toBe(0);
    expect(result.dynamicImports.length).toBe(1);
    expect(result.dynamicImports[0]?.snippet).toContain('require(modName)');
  });

  it('captures dynamic import(variable) into dynamicImports', () => {
    const src = `const m = 'lodash';\nimport(m).then(() => {});\n`;
    const result = parseImports(src, 'src/dyn.ts');
    expect(result.dynamicImports.length).toBe(1);
    expect(result.dynamicImports[0]?.line).toBe(2);
  });

  it('captures re-exports (export * / export { } from)', () => {
    const src = `export * from 'react';\nexport { useState } from 'react-dom';\n`;
    const result = parseImports(src, 'src/index.ts');
    expect(result.staticImports.map((s) => s.packageName).sort()).toEqual(['react', 'react-dom']);
  });
});

describe('categorizeFile (unit, spec §10.6)', () => {
  it('flags __tests__ paths as test', () => {
    expect(categorizeFile('src/__tests__/foo.ts')).toBe('test');
  });
  it('flags .test. and .spec. files as test', () => {
    expect(categorizeFile('src/foo.test.ts')).toBe('test');
    expect(categorizeFile('src/foo.spec.tsx')).toBe('test');
  });
  it('flags .stories. and .story. files as story', () => {
    expect(categorizeFile('src/Button.stories.tsx')).toBe('story');
    expect(categorizeFile('src/Button.story.ts')).toBe('story');
  });
  it('flags root *.config.{js,ts,mjs,cjs} as config', () => {
    expect(categorizeFile('vite.config.ts')).toBe('config');
    expect(categorizeFile('next.config.js')).toBe('config');
    expect(categorizeFile('jest.config.cjs')).toBe('config');
  });
  it('flags root dotfiles as config', () => {
    expect(categorizeFile('.eslintrc.js')).toBe('config');
  });
  it('flags everything else as prod', () => {
    expect(categorizeFile('src/components/App.tsx')).toBe('prod');
    // nested vite.config — only ROOT files become config
    expect(categorizeFile('packages/foo/vite.config.ts')).toBe('prod');
  });
});

describe('packageNameFromSpecifier (unit)', () => {
  it('returns name for bare specifiers', () => {
    expect(packageNameFromSpecifier('react')).toBe('react');
    expect(packageNameFromSpecifier('react/jsx-runtime')).toBe('react');
  });
  it('returns scope/name for scoped packages', () => {
    expect(packageNameFromSpecifier('@types/react')).toBe('@types/react');
    expect(packageNameFromSpecifier('@scope/pkg/foo/bar')).toBe('@scope/pkg');
  });
  it('returns null for relative + absolute + URL-like', () => {
    expect(packageNameFromSpecifier('./foo')).toBeNull();
    expect(packageNameFromSpecifier('../bar')).toBeNull();
    expect(packageNameFromSpecifier('/abs')).toBeNull();
    expect(packageNameFromSpecifier('node:fs')).toBeNull();
    expect(packageNameFromSpecifier('data:text/plain,foo')).toBeNull();
  });
});

describe('isParseable (unit)', () => {
  it('accepts the spec-listed extensions', () => {
    expect(isParseable('src/x.ts')).toBe(true);
    expect(isParseable('src/x.tsx')).toBe(true);
    expect(isParseable('src/x.js')).toBe(true);
    expect(isParseable('src/x.jsx')).toBe(true);
    expect(isParseable('src/x.mjs')).toBe(true);
    expect(isParseable('src/x.cjs')).toBe(true);
  });
  it('rejects .min.{js,mjs,cjs} via heuristic', () => {
    expect(isParseable('bundle.min.js')).toBe(false);
    expect(isParseable('bundle.min.mjs')).toBe(false);
    expect(isParseable('bundle.min.cjs')).toBe(false);
  });
  it('rejects unsupported extensions', () => {
    expect(isParseable('src/style.css')).toBe(false);
    expect(isParseable('README.md')).toBe(false);
  });
});

describe('scanCode (integration with filesystem)', () => {
  it('walks a project and groups imports by package name', async () => {
    sandbox = await createSandbox('scan-happy');
    const dir = await sandbox.scratch('project');
    await fs.writeFile(path.join(dir, 'app.tsx'), `import React from 'react';\nimport ReactDOM from 'react-dom';\n`);
    await fs.writeFile(path.join(dir, 'index.ts'), `import React from 'react';\n`);
    const result = await scanCode({ projectRoot: dir });
    expect(result.imports.get('react')?.length).toBe(2);
    expect(result.imports.get('react-dom')?.length).toBe(1);
  });

  it('skips bake-in folders (node_modules, .next, dist)', async () => {
    sandbox = await createSandbox('scan-bake-in');
    const dir = await sandbox.scratch('project');
    await fs.mkdir(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'foo', 'index.js'), `require('victim')`);
    await fs.mkdir(path.join(dir, '.next'), { recursive: true });
    await fs.writeFile(path.join(dir, '.next', 'cache.js'), `require('victim')`);
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist', 'bundle.js'), `require('victim')`);
    await fs.writeFile(path.join(dir, 'src.ts'), `import 'real';`);
    const result = await scanCode({ projectRoot: dir });
    expect(result.imports.has('victim')).toBe(false);
    expect(result.imports.has('real')).toBe(true);
  });

  it('respects .gitignore', async () => {
    sandbox = await createSandbox('scan-gitignore');
    const dir = await sandbox.scratch('project');
    await fs.writeFile(path.join(dir, '.gitignore'), `legacy/\n`);
    await fs.mkdir(path.join(dir, 'legacy'), { recursive: true });
    await fs.writeFile(path.join(dir, 'legacy', 'old.js'), `require('victim')`);
    await fs.writeFile(path.join(dir, 'src.ts'), `import 'real';`);
    const result = await scanCode({ projectRoot: dir });
    expect(result.imports.has('victim')).toBe(false);
    expect(result.imports.has('real')).toBe(true);
  });

  it('records oversized files in oversizedSkipped (>2MB cap)', async () => {
    sandbox = await createSandbox('scan-oversize');
    const dir = await sandbox.scratch('project');
    const big = 'x'.repeat(3 * 1024 * 1024);
    await fs.writeFile(path.join(dir, 'huge.ts'), big);
    await fs.writeFile(path.join(dir, 'small.ts'), `import 'react';`);
    const result = await scanCode({ projectRoot: dir });
    expect(result.oversizedSkipped.some((o) => o.path === 'huge.ts')).toBe(true);
    expect(result.imports.has('react')).toBe(true);
  });

  it('skips .min.{js,mjs,cjs} via heuristic', async () => {
    sandbox = await createSandbox('scan-min');
    const dir = await sandbox.scratch('project');
    await fs.writeFile(path.join(dir, 'bundle.min.js'), `require('victim')`);
    await fs.writeFile(path.join(dir, 'app.ts'), `import 'real';`);
    const result = await scanCode({ projectRoot: dir });
    expect(result.imports.has('victim')).toBe(false);
    expect(result.imports.has('real')).toBe(true);
  });

  it('emits dynamic imports', async () => {
    sandbox = await createSandbox('scan-dynamic');
    const dir = await sandbox.scratch('project');
    await fs.writeFile(
      path.join(dir, 'dyn.ts'),
      `const m = 'foo';\nconst dyn = require(m);\nimport(m).then(() => {});\n`
    );
    const result = await scanCode({ projectRoot: dir });
    expect(result.dynamicImports.length).toBeGreaterThanOrEqual(2);
    expect(result.dynamicImports[0]?.file).toBe('dyn.ts');
  });

  it('tags categories on the right files', async () => {
    sandbox = await createSandbox('scan-categories');
    const dir = await sandbox.scratch('project');
    await fs.mkdir(path.join(dir, '__tests__'), { recursive: true });
    await fs.writeFile(path.join(dir, '__tests__', 'a.ts'), `import 'react';`);
    await fs.writeFile(path.join(dir, 'b.stories.tsx'), `import 'react';`);
    await fs.writeFile(path.join(dir, 'vite.config.ts'), `import 'react';`);
    await fs.writeFile(path.join(dir, 'main.ts'), `import 'react';`);
    const result = await scanCode({ projectRoot: dir });
    const reactFiles = result.imports.get('react') ?? [];
    const cats = new Set(reactFiles.map((f) => f.category));
    expect(cats.has('test')).toBe(true);
    expect(cats.has('story')).toBe(true);
    expect(cats.has('config')).toBe(true);
    expect(cats.has('prod')).toBe(true);
  });
});
