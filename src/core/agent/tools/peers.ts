/**
 * `peer_requirements` (V2_STAGE4_SPEC 4a.5): the peer dependencies a target
 * version declares, checked against what the project declares and has
 * installed. Registry access is injected (`ctx.intel.fetchPackument`, which
 * owns its timeout and cache); project files are read through the path guard.
 */
import { promises as fs } from 'fs';
import semver from 'semver';
import { graphFileSet, pathGuard } from '../pathGuard';
import { ToolError, type AgentToolDef, type ToolContext } from '../types';

interface ManifestLike {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function readManifest(ctx: ToolContext, rel: string): Promise<ManifestLike | null> {
  try {
    const { abs } = await pathGuard(ctx.workspaceRoot, rel, graphFileSet(ctx.graph));
    return JSON.parse(await fs.readFile(abs, 'utf8')) as ManifestLike;
  } catch {
    return null;
  }
}

function declaredRange(m: ManifestLike | null, name: string): string | null {
  if (m === null) return null;
  return m.dependencies?.[name] ?? m.devDependencies?.[name] ?? m.optionalDependencies?.[name] ?? m.peerDependencies?.[name] ?? null;
}

function satisfies(version: string | null, declared: string | null, range: string): boolean | null {
  const candidate = version ?? (declared !== null && semver.validRange(declared) !== null ? semver.minVersion(declared)?.version ?? null : null);
  if (candidate === null) return null;
  try {
    return semver.satisfies(candidate, range, { includePrerelease: true, loose: true });
  } catch {
    return null;
  }
}

export function peerTools(): AgentToolDef[] {
  return [
    {
      name: 'peer_requirements',
      description:
        "Peer dependencies of a package version (from the npm registry) compared with the project's declared range and installed version of each peer.",
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pkg', 'version'],
        properties: {
          pkg: { type: 'string', description: 'npm package name.', maxLength: 214 },
          version: { type: 'string', description: 'Exact target version, e.g. "18.2.0".', maxLength: 64 }
        }
      },
      handler: async (ctx, input) => {
        const pkg = String(input.pkg);
        const version = String(input.version);
        if (ctx.intel.fetchPackument === undefined) throw new ToolError('registry access is not available in this run');
        let packument;
        try {
          packument = await ctx.intel.fetchPackument(pkg, ctx.signal);
        } catch (err) {
          throw new ToolError(`registry lookup for ${pkg} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const v = packument.versions?.[version];
        if (v === undefined) throw new ToolError(`${pkg}@${version} is not in the registry`);
        const root = await readManifest(ctx, 'package.json');
        const peers = [];
        for (const [name, range] of Object.entries(v.peerDependencies ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const declared = declaredRange(root, name);
          const installed = (await readManifest(ctx, `node_modules/${name}/package.json`))?.version ?? null;
          peers.push({
            name,
            range,
            optional: v.peerDependenciesMeta?.[name]?.optional === true,
            declared,
            installed,
            satisfied: satisfies(installed, declared, range)
          });
        }
        return { pkg, version, peers };
      }
    }
  ];
}
