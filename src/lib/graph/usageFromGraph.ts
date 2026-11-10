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
import { filesUsingPackage } from '@/core/graph/query';
import { JS_EXTS } from '@/core/graph/walk';
import type { GraphDriver } from '@/core/graph/store';
import type { EdgeKind } from '@/core/graph/types';
import { sha1Prefix } from '@/lib/scanners/code';
import type { UsageDetail, UsageDynamicImport, UsageFile, UsageOversized } from '@/lib/api-types';

/** Edge kinds v1's JS import scan saw; style-import / config-ref are not [C] material yet. */
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

function kindPlaceholders(): string {
  return JS_IMPORT_KINDS.map(() => '?').join(',');
}

/** Import lines of `filePath` whose edge targets `pkg` directly. */
function directStatements(h: GraphDriver, filePath: string, pkg: string): string[] {
  return h
    .prepare(
      `SELECT e.snippet FROM import_edge e
         JOIN file f ON f.id = e.from_file JOIN package p ON p.id = e.to_package
        WHERE f.path = ? AND p.name = ? AND e.kind IN (${kindPlaceholders()})
        ORDER BY e.line, e.col, e.id`
    )
    .all(filePath, pkg, ...JS_IMPORT_KINDS)
    .map((r) => String(r.snippet ?? ''));
}

/** Import lines of `filePath` whose bindings reach `pkg` through a re-export chain. */
function reexportStatements(h: GraphDriver, filePath: string, pkg: string): string[] {
  return h
    .prepare(
      `SELECT DISTINCT e.id, e.line, e.col, e.snippet FROM import_edge e
         JOIN file f ON f.id = e.from_file
         JOIN import_binding b ON b.edge_id = e.id
         JOIN binding_reach br ON br.binding_id = b.id
         JOIN package p ON p.id = br.package_id
        WHERE f.path = ? AND p.name = ? AND br.depth > 0
        ORDER BY e.line, e.col, e.id`
    )
    .all(filePath, pkg)
    .map((r) => String(r.snippet ?? ''));
}

function dynamicImports(h: GraphDriver): UsageDynamicImport[] {
  return h
    .prepare(
      `SELECT f.path, e.line, e.snippet FROM import_edge e JOIN file f ON f.id = e.from_file
        WHERE e.resolution = 'unresolved' AND e.unresolved_reason = 'dynamic-expression'
        ORDER BY f.path, e.line, e.col, e.id`
    )
    .all()
    .map((r) => ({ file: String(r.path), line: Number(r.line), snippet: String(r.snippet ?? '') }));
}

function oversizedSkipped(h: GraphDriver): UsageOversized[] {
  return h
    .prepare(`SELECT path, size FROM file WHERE skip_reason = 'oversized' ORDER BY path`)
    .all()
    .map((r) => ({ path: String(r.path), sizeBytes: Number(r.size), reason: OVERSIZED_REASON }));
}

export function usageFromGraph(h: GraphDriver, name: string): UsageDetail {
  const hits = filesUsingPackage(h, name, { transitive: true, wrapperDepth: 0, kinds: [...JS_IMPORT_KINDS] }).filter(
    (hit) => (hit.via === 'direct' || hit.via === 'reexport') && isJsPath(hit.path)
  );
  const files: UsageFile[] = hits.map((hit) => {
    const importStatements = hit.via === 'direct' ? directStatements(h, hit.path, name) : reexportStatements(h, hit.path, name);
    return {
      path: hit.path,
      pathHash: sha1Prefix(hit.path, 12),
      category: hit.category,
      importStatements,
      importCount: importStatements.length
    };
  });
  return {
    files,
    dynamicImports: dynamicImports(h),
    totalFiles: files.length,
    declaredButUnused: files.length === 0,
    oversizedSkipped: oversizedSkipped(h)
  };
}
