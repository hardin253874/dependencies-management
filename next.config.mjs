import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // NOTE: The instrumentation hook used to live here, but Next.js 14.2 builds
    // `instrumentation.ts` for BOTH edge and nodejs runtimes, and Webpack tries
    // to bundle Node builtins ('fs','path','os','crypto') into the edge chunk
    // where they don't exist. Boot logic (mkdir logs, temp sweep, env
    // reconciliation) is now lazy — `getLogger()` already mkdirs the log dir,
    // and the temp sweep + env reconciliation can be deferred to first use.
    // Re-enable only after restructuring boot to be edge-safe.
    // instrumentationHook: true,
    // Pin the workspace tracing root to this project. Without it, Next.js walks
    // parents looking for a lockfile and can land on an unrelated ancestor
    // workspace (e.g. C:\Developments\Develop\package-lock.json). In 14.2.x
    // this key lives under `experimental`.
    outputFileTracingRoot: __dirname,
    // Externalize server-only npm packages so they're `require()`-d at runtime
    // instead of bundled by Webpack. Required for:
    //  - p-limit / p-queue / p-retry (use Node subpath imports like `#async_hooks`
    //    that Webpack cannot statically resolve)
    //  - pino / pino-pretty (use worker threads + dynamic transports)
    //  - @npmcli/arborist, @yarnpkg/* (Node-only filesystem + child_process)
    //  - npm-registry-fetch (Node-only http internals)
    //  - @anthropic-ai/sdk, openai (use Node streams + Buffer)
    //  - @babel/parser, semver, ignore (work fine either way; externalize for
    //    consistency and to avoid Webpack re-bundling unnecessarily).
    serverComponentsExternalPackages: [
      'p-limit',
      'p-queue',
      'p-retry',
      'pino',
      'pino-pretty',
      '@npmcli/arborist',
      '@yarnpkg/lockfile',
      '@yarnpkg/parsers',
      'npm-registry-fetch',
      '@anthropic-ai/sdk',
      'openai',
      '@babel/parser',
      'semver',
      'ignore'
    ]
  },
  // Webpack/Watchpack workaround for Windows: explicitly exclude system
  // files at C:\ root that cause EINVAL on lstat in dev mode. Webpack
  // accepts either a RegExp or an array of glob strings for `ignored`;
  // Next.js's default is a RegExp. We replace it with the array form
  // (mixing types in the array fails schema validation).
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions ?? {}),
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          'C:/DumpStack.log.tmp',
          'C:/pagefile.sys',
          'C:/swapfile.sys',
          'C:/hiberfil.sys'
        ]
      };
    }
    return config;
  }
};

export default nextConfig;
