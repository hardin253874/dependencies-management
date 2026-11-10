/**
 * App wiring for the MCP adapter (V2_STAGE4_SPEC 4b.2): the shared `library/`
 * (same `_projects.json` / `project.json` / `graph.db` the web UI writes), a
 * per-call graph reader from core, registry intel with timeouts, and the file
 * logger (scope `mcp`). Nothing here writes outside `library/`.
 */
import path from 'path';
import { openGraphReader } from '../core/graph/store';
import { createAppIntel } from '../lib/agent/intel';
import { getLogger } from '../lib/logger';
import { graphDbPath, projectJsonPath } from '../lib/paths';
import { pathExists, readJson } from '../lib/storage/atomic';
import { findBySlug, readProjects } from '../lib/storage/projects';
import type { ProjectJson } from '../lib/projects/add';
import type { McpAdapterDeps, McpCallLog, McpProjectSummary } from './tools';

/** Points the server at another library (tests, or a library outside the repo). Must be absolute. */
export const LIBRARY_DIR_ENV = 'DEP_AGENT_LIBRARY_DIR';

/**
 * The web app resolves `library/` against its cwd, which is the repo root. An
 * MCP client starts the server from its own cwd (often the user's project), so
 * the default is derived from this file's location instead: `<repo>/library`.
 */
export function resolveMcpLibraryRoot(env: Readonly<Record<string, string | undefined>>, serverFile: string): string {
  const fromEnv = env[LIBRARY_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!path.isAbsolute(fromEnv)) throw new Error(`${LIBRARY_DIR_ENV} must be an absolute path`);
    return path.resolve(fromEnv);
  }
  return path.resolve(path.dirname(serverFile), '..', '..', 'library');
}

function graphStatus(slug: string): McpProjectSummary['graph'] {
  try {
    openGraphReader(graphDbPath(slug)).close();
    return 'built';
  } catch {
    return 'not-built';
  }
}

function logCall(entry: McpCallLog): void {
  void getLogger()
    .then((log) => log.child({ scope: 'mcp' }).info({ ...entry }, `mcp ${entry.tool}${entry.isError ? ' (error)' : ''}`))
    .catch(() => undefined);
}

export function appAdapterDeps(): McpAdapterDeps {
  return {
    listProjects: async () => {
      const reg = await readProjects();
      return reg.projects.map((p) => ({ slug: p.slug, name: p.name, path: p.absolutePath, graph: graphStatus(p.slug) }));
    },
    resolveProject: async (slug) => {
      // Only slugs present in `_projects.json` resolve, so a crafted slug can never point outside the library.
      const entry = await findBySlug(slug);
      if (entry === null) return null;
      const fp = projectJsonPath(entry.slug);
      if (!(await pathExists(fp))) throw new Error(`project "${entry.slug}" has no project.json; re-add it in the web UI`);
      const project = await readJson<ProjectJson>(fp);
      return { slug: entry.slug, workspaceRoot: project.path, graphDbPath: graphDbPath(entry.slug) };
    },
    openGraph: (dbPath) => openGraphReader(dbPath),
    intelFor: (workspaceRoot) => createAppIntel({ cwd: workspaceRoot }),
    log: logCall
  };
}
