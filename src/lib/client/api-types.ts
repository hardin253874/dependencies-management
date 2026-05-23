/**
 * FE-side re-export of the canonical API contract.
 *
 * The single source of truth lives at `src/lib/api-types.ts`. This barrel keeps
 * existing FE imports (`@/lib/client/api-types`) working while we migrate. New
 * code should import directly from `@/lib/api-types`.
 */
export * from '@/lib/api-types';
