/**
 * Ambient module declarations for third-party packages without published types.
 *
 * Keep this file thin. Only declare what we actually use in the codebase, and
 * include the exact shape we rely on so that consumers stay typed end-to-end.
 */

declare module '@yarnpkg/lockfile' {
  export interface LockfileParseResult {
    type: 'success' | 'merge' | 'conflict';
    object: Record<string, { version: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
  }

  export function parse(fileContents: string, fileLoc?: string): LockfileParseResult;
  export function stringify(json: Record<string, unknown>, noHeader?: boolean, enableVersions?: boolean): string;
}

/**
 * Global stylesheet side-effect imports (`import './globals.css'` in
 * app/layout.tsx). TypeScript 6 turns on `noUncheckedSideEffectImports` by
 * default, and Next 14's `next/types/global.d.ts` only declares `*.module.css`.
 * Webpack handles the import; this only tells tsc the module exists. Narrow
 * pattern on purpose: a bare '*.css' could shadow Next's typed '*.module.css'.
 */
declare module '*/globals.css';
