/**
 * v1 predictor adapter (v2 Stage 0.5) + the no-LLM guard for eval/.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { predictV1 } from '../../../eval/lib/predict-v1';
import type { CorpusPhase } from '../../../eval/lib/types';

const EVAL_DIR = path.resolve(__dirname, '../../../eval');

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function phase(id: string, names: string[]): CorpusPhase {
  return { id, toCommit: 'f'.repeat(40), packages: names.map((name) => ({ name, from: '1.0.0', to: '2.0.0' })) };
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

describe('predictV1', () => {
  it('unions import sites per phase and prefixes the projectDir', async () => {
    sandbox = await createSandbox('eval-predict');
    const clone = await sandbox.scratch('clone');
    await writeFiles(path.join(clone, 'web'), {
      'src/a.tsx': "import React from 'react';\n",
      'src/b.tsx': "import { useState } from 'react';\nimport Link from 'next/link';\n",
      'src/root.tsx': "import { createRoot } from 'react-dom/client';\n",
      'src/plain.ts': 'export const x = 1;\n'
    });

    const pred = await predictV1(
      {
        projectDirs: ['web'],
        phases: [phase('react-only', ['react']), phase('react-dom', ['react', 'react-dom']), phase('next', ['next'])]
      },
      clone
    );

    expect(pred.filesScanned).toBe(4);
    expect(pred.byPhase.get('react-only')).toEqual(['web/src/a.tsx', 'web/src/b.tsx']);
    expect(pred.byPhase.get('react-dom')).toEqual(['web/src/a.tsx', 'web/src/b.tsx', 'web/src/root.tsx']);
    // A subpath import maps to its package.
    expect(pred.byPhase.get('next')).toEqual(['web/src/b.tsx']);
  });

  it('gives an empty set for a package with no import sites', async () => {
    sandbox = await createSandbox('eval-predict');
    const clone = await sandbox.scratch('clone');
    await writeFiles(clone, { 'a.ts': "import x from 'lodash';\n" });
    const pred = await predictV1({ projectDirs: ['.'], phases: [phase('main', ['moment'])] }, clone);
    expect(pred.byPhase.get('main')).toEqual([]);
  });

  it('scans each projectDir once per case, not per phase', async () => {
    let scans = 0;
    const scan = async () => {
      scans += 1;
      return { imports: new Map(), dynamicImports: [], oversizedSkipped: [], totalFilesScanned: 0 };
    };
    await predictV1({ projectDirs: ['a', 'b'], phases: [phase('p1', ['x']), phase('p2', ['y'])] }, '/clone', scan);
    expect(scans).toBe(2);
  });
});

describe('no-LLM guard', () => {
  async function listTs(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'results' || entry.name === 'corpus') continue;
        out.push(...(await listTs(full)));
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('no file under eval/ imports an LLM module or SDK', async () => {
    const files = await listTs(EVAL_DIR);
    expect(files.length).toBeGreaterThan(5);
    const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of files) {
      const src = await fs.readFile(file, 'utf8');
      for (const m of src.matchAll(importRe)) {
        const spec = m[1] ?? '';
        if (/llm\/|@anthropic-ai|openai|src\/app\/|^next(\/|$)/.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
