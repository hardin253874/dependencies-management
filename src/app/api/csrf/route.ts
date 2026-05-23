/**
 * GET /api/csrf — returns the local-only CSRF token (spec §9.3).
 *
 * The only endpoint exempt from CSRF check. Token lifetime = server lifetime;
 * rotates on restart.
 */
import { NextResponse } from 'next/server';
import { getCsrfToken } from '@/lib/csrf';
import { withRequestLog } from '@/lib/http/guards';
import type { CsrfResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async () => {
  return NextResponse.json<CsrfResponse>({ token: getCsrfToken() });
});
