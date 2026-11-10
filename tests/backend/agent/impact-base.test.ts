/**
 * Base impacted set from the graph (v2 Stage 5a.2): `impactBaseSet` must give
 * exactly the v2-graph predictor's phase set for the same packages, so the app
 * report and the eval share one definition. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { impactBaseSet, isBaseHit } from '@/core/agent/impactBase';
import { filesUsingPackage } from '@/core/graph/query';
import { predictV2Graph } from '../../../eval/lib/predict-graph';

let sandbox: Sandbox;
const fixtures: Record<string, BuiltFixture> = {};

const CASES: Array<[fixture: string, packages: string[]]> = [
  ['wrapper-module', ['axios']],
  ['barrel-reexport', ['antd', 'lodash', 'react']],
  ['next-app-router', ['next', 'react']],
  ['scss-bootstrap', ['bootstrap']]
];

beforeAll(async () => {
  sandbox = await createSandbox('agent-impact-base');
  for (const [name] of CASES) fixtures[name] = await buildAgentFixture(sandbox, name);
}, 120_000);

afterAll(async () => {
  for (const fx of Object.values(fixtures)) fx.graph.close();
  await sandbox.dispose();
});

async function v2GraphSet(name: string, packages: string[]): Promise<string[]> {
  const fx = fixtures[name]!;
  const pred = await predictV2Graph(
    { id: `ib-${name}`, projectDirs: ['.'], phases: [{ id: 'p1', packages: packages.map((n) => ({ name: n, from: '1.0.0', to: '2.0.0' })) }] as never },
    fx.projectRoot,
    path.join(sandbox.scratchRoot, '_evalcache')
  );
  return pred.byPhase.get('p1') ?? [];
}

describe('impactBaseSet (5a.2)', () => {
  it.each(CASES)('%s: paths equal the v2-graph predictor phase set', async (name, packages) => {
    const base = impactBaseSet(fixtures[name]!.graph, packages);
    expect(base.length).toBeGreaterThan(0);
    expect(base.map((b) => b.path)).toEqual(await v2GraphSet(name, packages));
  });

  it('is path-ascending, deduplicated, and lists every package that reaches a file', () => {
    const base = impactBaseSet(fixtures['barrel-reexport']!.graph, ['antd', 'lodash', 'react']);
    const paths = base.map((b) => b.path);
    expect(paths).toEqual([...new Set(paths)].sort());
    const multi = base.filter((b) => b.packages.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const b of multi) expect(b.packages).toEqual([...b.packages].sort());
  });

  it('carries via, kind and confidence from the graph (best via wins on dedupe)', () => {
    const base = impactBaseSet(fixtures['wrapper-module']!.graph, ['axios']);
    const http = base.find((b) => b.path === 'src/lib/http.ts')!;
    expect(http).toMatchObject({ via: 'direct', kind: 'js', packages: ['axios'] });
    expect(['high', 'medium', 'low']).toContain(http.confidence);
    expect(base.filter((b) => b.via === 'wrapper').length).toBe(3);
  });

  it('style files are kept with kind "style" (direct style imports are in the base set)', () => {
    const graph = fixtures['scss-bootstrap']!.graph;
    const hits = filesUsingPackage(graph, 'bootstrap', { transitive: true, wrapperDepth: 1 });
    const base = impactBaseSet(graph, ['bootstrap']);
    expect(base.some((b) => b.kind === 'style' && b.via === 'direct')).toBe(true);
    expect(base.map((b) => b.path)).toEqual(hits.filter(isBaseHit).map((h) => h.path).sort());
  });

  // No fixture can produce one: only JS/TS files carry re-export bindings in the graph.
  it('the rule excludes a non-JS file reached via reexport and keeps every other hit', () => {
    expect(isBaseHit({ path: 'styles/main.scss', via: 'reexport' })).toBe(false);
    expect(isBaseHit({ path: 'config/app.json', via: 'reexport' })).toBe(false);
    expect(isBaseHit({ path: 'styles/main.scss', via: 'direct' })).toBe(true);
    expect(isBaseHit({ path: 'styles/main.scss', via: 'wrapper' })).toBe(true);
    expect(isBaseHit({ path: 'src/ui/index.mts', via: 'reexport' })).toBe(true);
  });

  it('unknown package → empty; no packages → empty', () => {
    expect(impactBaseSet(fixtures['wrapper-module']!.graph, ['no-such-pkg'])).toEqual([]);
    expect(impactBaseSet(fixtures['wrapper-module']!.graph, [])).toEqual([]);
  });
});
