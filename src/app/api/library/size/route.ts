/**
 * GET /api/library/size — total library disk usage in bytes (spec §9.3).
 *
 * Used by Settings → Library to display "Library size: 12.4 MB" alongside the
 * "Open in file explorer" button.
 */
import { NextResponse } from 'next/server';
import { computeLibrarySize } from '@/lib/storage/size';
import { internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import type { LibrarySizeResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async (): Promise<NextResponse> => {
  try {
    const payload = await computeLibrarySize();
    return NextResponse.json<LibrarySizeResponse>(payload);
  } catch (err) {
    return internalError('LIBRARY_SIZE_FAILED', (err as Error).message);
  }
});
