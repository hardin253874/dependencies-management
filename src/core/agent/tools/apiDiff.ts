/**
 * `api_diff` tool (V2_STAGE4_SPEC 4a.4): the package API diff joined to this
 * project's usage sites — for every removed or signature-changed export, the
 * graph sites that use it (as a named import, or as a member of the default /
 * namespace import), max 20 per symbol plus the total count.
 */
import { usageSites } from '../../graph/query';
import { computeApiDiff } from '../../intel/apiDiff';
import type { UsageSite } from '../../graph/types';
import type { AgentToolDef, ToolContext } from '../types';

export const API_DIFF_SITES_PER_SYMBOL = 20;
const ALL = { limit: 100_000 };

function sitesFor(ctx: ToolContext, pkg: string, name: string): { sites: UsageSite[]; total: number } {
  const direct = usageSites(ctx.graph, pkg, name, undefined, ALL);
  const viaMember = usageSites(ctx.graph, pkg, undefined, name, ALL).filter((s) => s.symbol === 'default' || s.symbol === '*');
  const seen = new Set<string>();
  const all: UsageSite[] = [];
  for (const s of [...direct, ...viaMember]) {
    const key = `${s.path}:${s.line}:${s.col}:${s.symbol}:${s.member ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(s);
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col));
  return { sites: all.slice(0, API_DIFF_SITES_PER_SYMBOL), total: all.length };
}

export function apiDiffTools(): AgentToolDef[] {
  return [
    {
      name: 'api_diff',
      description:
        "Exported API diff of a package between two versions (from its type definitions or the matching @types package): removed, signature-changed, added, possible renames. Each removed/changed export lists this project's usage sites.",
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pkg', 'from', 'to'],
        properties: {
          pkg: { type: 'string', description: 'npm package name.', maxLength: 214 },
          from: { type: 'string', description: 'Exact installed version.', maxLength: 64 },
          to: { type: 'string', description: 'Exact target version.', maxLength: 64 }
        }
      },
      handler: async (ctx, input) => {
        const pkg = String(input.pkg);
        const diff = await computeApiDiff(ctx.intel, pkg, String(input.from), String(input.to), ctx.signal);
        if (diff.status !== 'ok') return diff;
        return {
          ...diff,
          removed: diff.removed.map((e) => ({ ...e, usage: sitesFor(ctx, pkg, e.name) })),
          signatureChanged: diff.signatureChanged.map((e) => ({ ...e, usage: sitesFor(ctx, pkg, e.name) }))
        };
      }
    }
  ];
}
