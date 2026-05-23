/**
 * Helper: decode + validate a package name from URL params.
 *
 * Spec §9.2: scoped names arrive URL-encoded (`@types%2Freact`). We decode,
 * then validate against the allowlist regex BEFORE any filesystem operation.
 *
 * Returns either the validated name or null. The caller should respond with
 * `badRequest('INVALID_PACKAGE_NAME', …)` on null.
 */
import { isValidPackageName } from './validate';

export function decodeAndValidatePackageName(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Defensive: reject any literal `..` segment even if the regex would catch
  // it. Mirrors the discipline in src/lib/projects/validate.ts.
  for (const segment of decoded.split(/[/\\]/)) {
    if (segment === '..') return null;
  }
  if (!isValidPackageName(decoded)) return null;
  return decoded;
}
