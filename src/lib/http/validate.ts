/**
 * URL-parameter allowlist validation (spec §9.2 / §9.4).
 *
 * Every param that ends up on the filesystem must be validated against a
 * strict regex BEFORE any filesystem operation. This is the path-traversal
 * defense.
 */

/** Slug, version, pathHash, jobId: alphanumerics + `@._-`. */
export const PARAM_RE = /^[a-zA-Z0-9@._-]+$/;

/** Scoped package name (after URL decoding). */
export const PACKAGE_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;

export function isValidParam(value: string): boolean {
  if (typeof value !== 'string' || value === '' || value.length > 256) return false;
  if (value.includes('..')) return false;
  return PARAM_RE.test(value);
}

export function isValidPackageName(value: string): boolean {
  if (typeof value !== 'string' || value === '' || value.length > 214) return false;
  if (value.includes('..')) return false;
  return PACKAGE_NAME_RE.test(value);
}

/**
 * Version param (`:from`, `:to`, `:version`) validation. Permissive but
 * bounded — semver-like characters only, no `..` segments. Used by every
 * route that takes a version path param so that the same guard is applied
 * before any filesystem operation.
 *
 * Aligns with `isValidParam` semantics (see also Stage 3 review item M1).
 */
export const VERSION_PARAM_RE = /^[a-zA-Z0-9._+-]+$/;

export function isValidVersionParam(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  // Defensive: reject `..` BEFORE the regex pass so embedded `1.0..0`
  // (which the regex would accept) is also rejected.
  if (value.includes('..')) return false;
  return VERSION_PARAM_RE.test(value);
}
