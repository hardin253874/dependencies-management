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
