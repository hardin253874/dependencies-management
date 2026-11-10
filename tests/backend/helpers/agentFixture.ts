/**
 * Agent tool fixtures (Stage 4a): a Stage 3 graph fixture copied into the
 * sandbox, built, and wrapped in a `ToolContext` whose workspace root is the
 * sandbox copy (never the committed fixture folder).
 */
import { buildGraph } from '@/core/graph/build';
import { openGraphReader, type GraphDriver } from '@/core/graph/store';
import { DEFAULT_TOOL_LIMITS, type IntelContext, type ToolContext } from '@/core/agent/types';
import type { Sandbox } from './sandbox';
import { copyGraphFixture } from './graphFixture';

export interface BuiltFixture {
  projectRoot: string;
  dbPath: string;
  graph: GraphDriver;
  ctx: (over?: Partial<ToolContext>) => ToolContext;
}

const noLock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

export async function buildAgentFixture(
  sandbox: Sandbox,
  name: string,
  opts: { as?: string; prepare?: (root: string) => Promise<void>; intel?: IntelContext } = {}
): Promise<BuiltFixture> {
  const { projectRoot, dbPath } = await copyGraphFixture(sandbox, name, opts.as ?? name);
  if (opts.prepare !== undefined) await opts.prepare(projectRoot);
  await buildGraph({ projectRoot, dbPath, mode: 'full', lock: noLock });
  const graph = openGraphReader(dbPath);
  return {
    projectRoot,
    dbPath,
    graph,
    ctx: (over = {}) => ({ workspaceRoot: projectRoot, graph, intel: opts.intel ?? {}, limits: { ...DEFAULT_TOOL_LIMITS }, ...over })
  };
}
