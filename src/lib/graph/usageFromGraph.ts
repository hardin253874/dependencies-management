/**
 * Compatibility layer: view [C]'s unchanged `UsageDetail` payload from the
 * code graph (V2_STAGE3_SPEC 3b-A.2, D21). Replaces the `scanCode → UsageDetail`
 * mapping that was copy-pasted into three routes. `scanCode` itself stays, so
 * the eval's v1 baseline predictor keeps measuring v1.
 *
 * Which files count (Stage 3, Q3): JS/TS files whose hit is `direct` or
 * `reexport`. Wrapper hits, style imports and config refs stay out of [C]
 * until the UI can show `via`/`confidence` (Stage 4).
 *
 * Intended differences from v1, each covered by a parity test:
 * - tsconfig `paths` / bundler aliases resolve to project files, so `@/x`
 *   is no longer reported as a package named `@/x`.
 * - A consumer that gets the package through a barrel re-export is listed
 *   (via reexport); its importStatements are the barrel imports.
 * - Lists are in a stable order (path, then line) instead of parse-completion order.
 */
import { dynamicImports, filesUsingPackage, importStatements, skippedFiles } from '@/core/graph/query';
import { JS_EXTS } from '@/core/graph/walk';
import type { GraphDriver } from '@/core/graph/store';
import type { EdgeKind } from '@/core/graph/types';
import { sha1Prefix } from '@/lib/scanners/code';
import type { UsageDetail, UsageFile } from '@/lib/api-types';

/** Edge kinds v1's JS import scan saw; style-import / config-ref / module-augmentation are not [C] material yet. */
const JS_IMPORT_KINDS: readonly EdgeKind[] = Object.freeze([
  'static',
  'require',
  'dynamic-literal',
  'type-only',
  'side-effect',
  'export-from'
]);

// Same wording as v1 `scanCode` so cached and fresh payloads read the same.
const OVERSIZED_REASON = 'exceeds 2MB cap';

function isJsPath(p: string): boolean {
  const lower = p.toLowerCase();
  return JS_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * All reads go through `src/core/graph/query.ts` (OQ-3b-A1), so this module
 * does not depend on schema columns. One statement query per package, not per file.
 */
export function usageFromGraph(h: GraphDriver, name: string): UsageDetail {
  const hits = filesUsingPackage(h, name, { transitive: true, wrapperDepth: 0, kinds: [...JS_IMPORT_KINDS] }).filter(
    (hit) => (hit.via === 'direct' || hit.via === 'reexport') && isJsPath(hit.path)
  );
  const statements = new Map<string, string[]>();
  for (const st of importStatements(h, name, { kinds: JS_IMPORT_KINDS })) {
    const key = `${st.via}:${st.path}`;
    const list = statements.get(key);
    if (list === undefined) statements.set(key, [st.snippet]);
    else list.push(st.snippet);
  }
  const files: UsageFile[] = hits.map((hit) => {
    const importStatementsOfFile = statements.get(`${hit.via}:${hit.path}`) ?? [];
    return {
      path: hit.path,
      pathHash: sha1Prefix(hit.path, 12),
      category: hit.category,
      importStatements: importStatementsOfFile,
      importCount: importStatementsOfFile.length
    };
  });
  return {
    files,
    dynamicImports: dynamicImports(h).map((d) => ({ file: d.path, line: d.line, snippet: d.snippet })),
    totalFiles: files.length,
    declaredButUnused: files.length === 0,
    // v1 listed oversized JS/TS files only (OQ-3b-A2): a huge stylesheet is not a [C] import site.
    oversizedSkipped: skippedFiles(h, { reason: 'oversized', kinds: ['js'] }).map((f) => ({
      path: f.path,
      sizeBytes: f.size,
      reason: OVERSIZED_REASON
    }))
  };
}
