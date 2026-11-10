import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // NOTE: instrumentation.ts stays off. Next.js 14.2 built it for BOTH edge
  // and nodejs runtimes, and Webpack tried to bundle Node builtins
  // ('fs','path','os','crypto') into the edge chunk where they don't exist.
  // Boot logic (mkdir logs, temp sweep, env reconciliation) is lazy instead —
  // `getLogger()` already mkdirs the log dir, and the temp sweep + env
  // reconciliation run on first use (`ensureBooted`). Revisit in a later stage.

  // Pin the workspace tracing root to this project. Without it, Next.js walks
  // parents looking for a lockfile and can land on an unrelated ancestor
  // workspace (e.g. C:\Developments\Develop\package-lock.json). Top-level
  // since Next 15 (was `experimental.outputFileTracingRoot` in 14.2).
  outputFileTracingRoot: __dirname,
  // Same quirk for Turbopack (dev bundler since Stage 2.6): it infers its root
  // from the nearest lockfile and only resolves/watches files inside it, and
  // the ancestor C:\Developments\Develop\package-lock.json would win. Keep this
  // identical to `outputFileTracingRoot`.
  turbopack: { root: __dirname },
  // Externalize server-only npm packages so they're `require()`-d at runtime
  // instead of bundled. Required for:
  //  - p-limit / p-queue / p-retry (use Node subpath imports like `#async_hooks`
  //    that the bundler cannot statically resolve)
  //  - @npmcli/arborist, @yarnpkg/* (Node-only filesystem + child_process)
  //  - npm-registry-fetch (Node-only http internals)
  //  - @anthropic-ai/sdk (uses Node streams + Buffer)
  //  - @babel/parser, semver, ignore (work fine either way; externalize for
  //    consistency and to avoid re-bundling unnecessarily).
  // Top-level `serverExternalPackages` since Next 15 (was
  // `experimental.serverComponentsExternalPackages` in 14.2).
  serverExternalPackages: [
    'p-limit',
    'p-queue',
    'p-retry',
    '@npmcli/arborist',
    '@yarnpkg/lockfile',
    '@yarnpkg/parsers',
    'npm-registry-fetch',
    '@anthropic-ai/sdk',
    '@babel/parser',
    'semver',
    'ignore'
  ]
};

export default nextConfig;
