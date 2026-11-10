/**
 * Graph tools (V2_STAGE4_SPEC 4a.2): read-only wrappers over
 * `core/graph/query.ts`, shaped for a model — compact JSON, paginated
 * (`{ items, total, nextOffset }`), confidence on every hit, POSIX paths
 * relative to `workspaceRoot`, stable (path asc) order. Unknown package or
 * file → empty result, never an error. No SQL lives here: every read goes
 * through `query.ts` (or the `rows.ts` file listing for the summary).
 */
import {
  affectedEntryPoints,
  dependents,
  filesUsingPackage,
  graphInfo,
  symbolsUsed,
  testsCovering,
  unresolved,
  usageSites,
  wrappers
} from '../../graph/query';
import { createRows } from '../../graph/rows';
import { ToolError, type AgentSchemaProperty, type AgentToolDef } from '../types';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_DEPENDENTS_DEPTH = 5;
export const MAX_TESTS_COVERING_FILES = 100;
/** Upper bound of rows pulled from query.ts before paging in memory. */
const QUERY_ROW_CAP = 100_000;
const ENTRY_POINTS_IN_SUMMARY = 50;

const PKG: AgentSchemaProperty = { type: 'string', description: 'npm package name, e.g. "react" or "@mui/material".', maxLength: 214 };
const LIMIT: AgentSchemaProperty = { type: 'integer', description: `Page size (default ${DEFAULT_PAGE_LIMIT}).`, minimum: 1, maximum: MAX_PAGE_LIMIT };
const OFFSET: AgentSchemaProperty = { type: 'integer', description: 'Items to skip (use nextOffset from the previous page).', minimum: 0 };
const FILE: AgentSchemaProperty = { type: 'string', description: 'Project-relative POSIX path, e.g. "src/app/page.tsx".', maxLength: 1024 };

export interface Paged<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}

export function paginate<T>(all: readonly T[], input: Record<string, unknown>): Paged<T> {
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_PAGE_LIMIT;
  const offset = typeof input.offset === 'number' ? input.offset : 0;
  const items = all.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, total: all.length, nextOffset: end < all.length ? end : null };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

export function graphTools(): AgentToolDef[] {
  return [
    {
      name: 'graph_summary',
      description:
        'Overview of the project code graph: file counts by category/kind, packages, import edges, unresolved imports, and entry points (pages, routes, main files).',
      capability: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: (ctx) => {
        const info = graphInfo(ctx.graph);
        const files = createRows(ctx.graph).allFiles();
        const byCategory: Record<string, number> = {};
        const byKind: Record<string, number> = {};
        const entryPoints: Array<{ path: string; role: string }> = [];
        for (const f of files) {
          byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
          byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
          if (f.role !== null) entryPoints.push({ path: f.path, role: f.role });
        }
        entryPoints.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return {
          builtAt: info.meta.builtAt ?? null,
          files: info.counts.files,
          filesByCategory: byCategory,
          filesByKind: byKind,
          packages: info.counts.packages,
          importEdges: info.counts.edges,
          unresolvedImports: info.counts.unresolved,
          usages: info.counts.usages,
          entryPoints: entryPoints.slice(0, ENTRY_POINTS_IN_SUMMARY),
          entryPointsTotal: entryPoints.length
        };
      }
    },
    {
      name: 'files_using_package',
      description:
        'Files that use an npm package: direct imports, re-exports through barrels, and wrapper modules (via + viaPath + confidence on each hit). Path-sorted, paginated.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pkg'],
        properties: {
          pkg: PKG,
          transitive: { type: 'boolean', description: 'Include re-export and wrapper hits (default true).' },
          wrapper_depth: { type: 'integer', description: 'Wrapper layers to follow (default 1, 0 = none).', minimum: 0, maximum: MAX_DEPENDENTS_DEPTH },
          limit: LIMIT,
          offset: OFFSET
        }
      },
      handler: (ctx, input) => {
        const hits = filesUsingPackage(ctx.graph, str(input, 'pkg')!, {
          transitive: typeof input.transitive === 'boolean' ? input.transitive : undefined,
          wrapperDepth: typeof input.wrapper_depth === 'number' ? input.wrapper_depth : undefined
        });
        return paginate(hits, input);
      }
    },
    {
      name: 'symbols_used',
      description: 'Exports of an npm package the project actually uses (symbol + first member, with counts), most used first.',
      capability: 'read',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pkg'], properties: { pkg: PKG, limit: LIMIT, offset: OFFSET } },
      handler: (ctx, input) => paginate(symbolsUsed(ctx.graph, str(input, 'pkg')!), input)
    },
    {
      name: 'usage_sites',
      description:
        'Call/JSX/member usage sites of an npm package (optionally one symbol and member), with line, column, a one-line snippet and confidence. Path/line ordered, paginated.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pkg'],
        properties: {
          pkg: PKG,
          symbol: { type: 'string', description: 'Export name, e.g. "default" or "useState".', maxLength: 200 },
          member: { type: 'string', description: 'Member accessed on the symbol, e.g. "get" for axios.get.', maxLength: 200 },
          limit: LIMIT,
          offset: OFFSET
        }
      },
      handler: (ctx, input) =>
        paginate(usageSites(ctx.graph, str(input, 'pkg')!, str(input, 'symbol'), str(input, 'member'), { limit: QUERY_ROW_CAP }), input)
    },
    {
      name: 'dependents',
      description: 'Files that import a given project file, directly or transitively (reverse import closure) with their distance.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          file: FILE,
          depth: { type: 'integer', description: 'Max distance (default 3).', minimum: 1, maximum: MAX_DEPENDENTS_DEPTH },
          limit: LIMIT,
          offset: OFFSET
        }
      },
      handler: (ctx, input) =>
        paginate(dependents(ctx.graph, str(input, 'file')!, { depth: typeof input.depth === 'number' ? input.depth : 3 }), input)
    },
    {
      name: 'affected_entry_points',
      description: 'Entry points (pages, routes, main files) reached from the users of a package OR from one file. Pass exactly one of pkg / file.',
      capability: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: { pkg: PKG, file: FILE, limit: LIMIT, offset: OFFSET } },
      handler: (ctx, input) => {
        const pkg = str(input, 'pkg');
        const file = str(input, 'file');
        if ((pkg === undefined) === (file === undefined)) throw new ToolError('pass exactly one of pkg or file');
        return paginate(affectedEntryPoints(ctx.graph, pkg !== undefined ? pkg : { file: file! }), input);
      }
    },
    {
      name: 'tests_covering',
      description: 'Test files whose import closure reaches any of the given project files.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['files'],
        properties: {
          files: { type: 'array', items: FILE, maxItems: MAX_TESTS_COVERING_FILES, description: 'Project-relative POSIX paths.' },
          limit: LIMIT,
          offset: OFFSET
        }
      },
      handler: (ctx, input) => paginate(testsCovering(ctx.graph, input.files as string[]), input)
    },
    {
      name: 'wrappers',
      description: 'Project files that import a package directly and re-export something (wrapper candidates: changing the package often means changing these).',
      capability: 'read',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pkg'], properties: { pkg: PKG, limit: LIMIT, offset: OFFSET } },
      handler: (ctx, input) => paginate(wrappers(ctx.graph, str(input, 'pkg')!), input)
    },
    {
      name: 'unresolved_imports',
      description: 'Imports the graph could not resolve (with reason and snippet), plus a summary of how much of the graph is unresolved.',
      capability: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: { limit: LIMIT, offset: OFFSET } },
      handler: (ctx, input) => {
        const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_PAGE_LIMIT;
        const offset = typeof input.offset === 'number' ? input.offset : 0;
        const { items, summary } = unresolved(ctx.graph, { limit, offset });
        const end = offset + items.length;
        return { items, total: summary.unresolved, nextOffset: end < summary.unresolved ? end : null, summary };
      }
    }
  ];
}
