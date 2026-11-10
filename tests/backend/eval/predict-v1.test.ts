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

  // v2 Stage 4a: the AI predictors (v2-agent, v1-ai) and the CLI that wires
  // them may import LLM services, but only with injected models.
  // v2 Stage 4c: `eval/lib/real.ts` is the ONLY eval file that may import a
  // real client (SDK, `llm/anthropic`, `llm/agentAnthropic`), and it must
  // build them behind the spend gate. The LLM factory stays forbidden.
  // v2 Stage 5b: `router-arms.ts` imports the core router (rules + Jev-answer
  // mapping, no client) and `judge.ts` the co-upgrade pairing table (J5
  // baseline); neither builds a model or client (the REAL_CLIENT_RE check
  // below still applies to them).
  const AI_PREDICTOR_FILES = new Set(['cli.ts', 'predict-agent.ts', 'predict-v1-ai.ts', 'real.ts', 'router-arms.ts', 'judge.ts']);
  const REAL_CLIENT_FILE = path.join(EVAL_DIR, 'lib', 'real.ts');
  const REAL_CLIENT_RE = /@anthropic-ai|openai|llm\/anthropic|llm\/agentAnthropic|llm\/factory|src\/app\/|^next(\/|$)/;

  it('no file under eval/ imports a real LLM client or SDK; only the AI predictor files import LLM modules', async () => {
    const files = await listTs(EVAL_DIR);
    expect(files.length).toBeGreaterThan(5);
    const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of files) {
      const src = await fs.readFile(file, 'utf8');
      const aiFile = AI_PREDICTOR_FILES.has(path.basename(file));
      for (const m of src.matchAll(importRe)) {
        const spec = m[1] ?? '';
        const realAllowed = file === REAL_CLIENT_FILE && !/llm\/factory|openai|src\/app\/|^next(\/|$)/.test(spec);
        if ((REAL_CLIENT_RE.test(spec) && !realAllowed) || (!aiFile && /llm\//.test(spec))) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('v2 Stage 5b: only real.ts imports the TypeSafe SDK or the real Jev client (others: type-only)', async () => {
    const files = await listTs(EVAL_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      if (file === REAL_CLIENT_FILE) continue;
      const src = await fs.readFile(file, 'utf8');
      // One import statement per `;`-chunk; `import type` (erased at build) is allowed.
      for (const chunk of src.split(';')) {
        const m = /(?:^|\n)import\s+(type\s)?[\s\S]*?from\s+['"]([^'"]+)['"]\s*$/.exec(chunk);
        if (m === null || m[1] !== undefined) continue;
        if (/@typesafe-ai|core\/judge\/client/.test(m[2] ?? '')) offenders.push(`${file}: ${m[2] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
    const real = await fs.readFile(REAL_CLIENT_FILE, 'utf8');
    expect(real).toMatch(/TypeSafeJudgeClient\(\{ apiKey: opts\.apiKey, gate: opts\.gate/);
  });

  it('the real-client file builds its clients behind the spend gate', async () => {
    const src = await fs.readFile(REAL_CLIENT_FILE, 'utf8');
    expect(src).toMatch(/from '\.\.\/\.\.\/src\/core\/spend\/gate'/);
    expect(src).toMatch(/maxRetries: 0/);
    expect(src).toMatch(/wrapLlmClient\(/);
    expect(src).toMatch(/agentGate\(/);
  });
});
