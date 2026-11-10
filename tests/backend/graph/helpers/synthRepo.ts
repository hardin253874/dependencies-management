/**
 * Deterministic synthetic TS/JS project for the graph perf budgets
 * (V2_STAGE3_SPEC 3a.10). Generated into a sandbox, never committed.
 *
 * Shape (seeded, so every run produces the same tree):
 *  - ~10 imports per source file: 3 packages, 4 relative, 1 `@/` paths alias,
 *    1 barrel (`@/ui`), 1 wrapper (`@/lib/http` → axios) on a third of files;
 *  - ~5 % style files (`.scss` with a relative partial + `~bootstrap/...`);
 *  - ~10 % test files importing one module each;
 *  - every imported binding is used once (call), so usages are realistic.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SynthRepoOptions {
  root: string;
  files: number;
  seed?: number;
}

export interface SynthRepoInfo {
  /** Every generated source file, POSIX relative. */
  files: string[];
  /** A prod module safe to edit in a rescan test. */
  editable: string;
  packages: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PACKAGES = [
  'react', 'react-dom', 'lodash', 'moment', 'dayjs', 'classnames', 'redux', 'react-redux', 'reselect', 'immer',
  'date-fns', 'uuid', 'qs', 'zod', 'yup', 'formik', 'rxjs', 'ramda', 'clsx', 'nanoid',
  'styled-components', '@emotion/react', '@mui/material', 'antd', 'chart.js', 'd3', 'i18next', 'react-router-dom', 'swr', 'graphql'
];

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

function relSpec(from: string, to: string): string {
  const r = path.posix.relative(path.posix.dirname(from), to).replace(/\.(tsx?|jsx?)$/, '');
  return r.startsWith('.') ? r : `./${r}`;
}

export async function generateSynthRepo(opts: SynthRepoOptions): Promise<SynthRepoInfo> {
  const rnd = mulberry32(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const { root } = opts;

  const deps: Record<string, string> = { axios: '1.6.8', bootstrap: '5.3.3' };
  for (const p of PACKAGES) deps[p] = '1.0.0';
  await write(root, 'package.json', JSON.stringify({ name: 'synth', version: '1.0.0', dependencies: deps }, null, 2));
  await write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, jsx: 'preserve' } }, null, 2));
  await write(root, 'src/lib/http.ts', "import axios from 'axios';\n\nexport const get = (u: string) => axios.get(u);\nexport const post = (u: string, b: unknown) => axios.post(u, b);\n");

  const uiCount = 20;
  const barrel: string[] = [];
  for (let i = 0; i < uiCount; i += 1) {
    await write(root, `src/ui/Widget${i}.tsx`, `import clsx from 'clsx';\n\nexport const Widget${i} = () => clsx('w${i}');\n`);
    barrel.push(`export * from './Widget${i}';`);
  }
  await write(root, 'src/ui/index.ts', `${barrel.join('\n')}\n`);

  const files: string[] = ['src/lib/http.ts', 'src/ui/index.ts'];
  const fixed = uiCount + 2 + 3; // ui widgets + barrel + http + package.json + tsconfig
  const remaining = Math.max(0, opts.files - fixed);
  const styleCount = Math.round(remaining * 0.05);
  const testCount = Math.round(remaining * 0.1);
  const moduleCount = remaining - styleCount - testCount;

  const modules: string[] = [];
  for (let i = 0; i < moduleCount; i += 1) {
    const dir = `src/feature${i % 40}/sub${Math.floor(i / 40) % 5}`;
    const ext = i % 7 === 0 ? 'js' : i % 5 === 0 ? 'tsx' : 'ts';
    modules.push(`${dir}/mod${i}.${ext}`);
  }

  for (let i = 0; i < modules.length; i += 1) {
    const rel = modules[i]!;
    const lines: string[] = [];
    const calls: string[] = [];
    const usedPkgs = new Set<string>();
    while (usedPkgs.size < 3) usedPkgs.add(pick(PACKAGES));
    let n = 0;
    for (const p of usedPkgs) {
      const local = `pkg${n++}`;
      lines.push(`import ${local} from '${p}';`);
      calls.push(`${local}.run?.();`);
    }
    // Relative imports point at earlier modules only, so the graph stays a DAG plus barrels.
    const targets = new Set<number>();
    for (let k = 0; k < 4 && i > 0; k += 1) targets.add(Math.floor(rnd() * i));
    for (const t of targets) {
      lines.push(`import { f${t} } from '${relSpec(rel, modules[t]!)}';`);
      calls.push(`f${t}();`);
    }
    if (i > 0) {
      const t = Math.floor(rnd() * i);
      if (!targets.has(t)) {
        lines.push(`import { f${t} } from '@/${modules[t]!.slice(4).replace(/\.(tsx?|jsx?)$/, '')}';`);
        calls.push(`f${t}();`);
      }
    }
    const w = Math.floor(rnd() * uiCount);
    lines.push(`import { Widget${w} } from '@/ui';`);
    calls.push(`Widget${w}();`);
    if (i % 3 === 0) {
      lines.push("import { get } from '@/lib/http';");
      calls.push(`void get('/m${i}');`);
    }
    lines.push('', `export function f${i}() {`, ...calls.map((c) => `  ${c}`), `  return ${i};`, '}', '');
    await write(root, rel, lines.join('\n'));
    files.push(rel);
  }

  for (let i = 0; i < styleCount; i += 1) {
    const rel = `src/styles/s${i}.scss`;
    const partial = `src/styles/_p${i}.scss`;
    await write(root, partial, `$c${i}: red;\n`);
    await write(root, rel, `@import './p${i}';\n@import '~bootstrap/scss/variables';\n.s${i} { color: $c${i}; }\n`);
    files.push(rel);
  }

  for (let i = 0; i < testCount; i += 1) {
    const target = modules[Math.floor(rnd() * modules.length)]!;
    const rel = target.replace(/\.(tsx?|jsx?)$/, `.t${i}.test.ts`);
    const fn = /mod(\d+)\./.exec(target)![1];
    await write(root, rel, `import { f${fn} } from '${relSpec(rel, target)}';\n\ntest('f${fn}', () => {\n  expect(f${fn}()).toBe(${fn});\n});\n`);
    files.push(rel);
  }

  return { files, editable: modules[Math.floor(modules.length / 2)]!, packages: ['axios', 'bootstrap', ...PACKAGES] };
}
