/**
 * Project slug computation (spec §6.2).
 *
 * Slug = first 8 chars of sha1(absolutePath). On collision against an existing
 * slug, append `-2`, `-3`, … until unique.
 */
import crypto from 'crypto';

export function baseSlug(absolutePath: string): string {
  return crypto.createHash('sha1').update(absolutePath).digest('hex').slice(0, 8);
}

export function resolveSlug(absolutePath: string, existingSlugs: string[]): string {
  const base = baseSlug(absolutePath);
  if (!existingSlugs.includes(base)) return base;
  let n = 2;
  while (existingSlugs.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
