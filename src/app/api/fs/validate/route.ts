/**
 * GET /api/fs/validate?path=… — run §6.2 validation without registering (spec §9.3).
 */
import { NextResponse } from 'next/server';
import { validateProjectPath } from '@/lib/projects/validate';
import { withRequestLog } from '@/lib/http/guards';
import type { FsValidationResponse, FsValidationCode } from '@/lib/api-types';

const codeMap: Record<string, FsValidationCode> = {
  NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  NOT_FOUND: 'PATH_NOT_FOUND',
  NOT_DIRECTORY: 'NOT_A_DIRECTORY',
  NO_PACKAGE_JSON: 'NO_PACKAGE_JSON',
  INVALID_PACKAGE_JSON: 'INVALID_PACKAGE_JSON',
  NO_LOCKFILE: 'NO_LOCKFILE',
  INSIDE_AGENT: 'INSIDE_AGENT',
  DUPLICATE: 'DUPLICATE_PROJECT'
};

export const GET = withRequestLog<unknown>(async (req): Promise<NextResponse<FsValidationResponse>> => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('path') ?? '';
  const result = await validateProjectPath(requested);
  if (!result.ok) {
    const code = codeMap[result.error.code] ?? 'PATH_NOT_FOUND';
    return NextResponse.json<FsValidationResponse>({
      ok: false,
      code,
      message: result.error.message
    });
  }

  const warning = result.nestedUnderSlug !== null
    ? `Nested under an existing project (slug ${result.nestedUnderSlug}).`
    : undefined;

  return NextResponse.json<FsValidationResponse>({
    ok: true,
    code: 'OK',
    message: 'Path is a valid target project.',
    packageManager: result.packageManager,
    workspacesDetected: result.workspacesDetected,
    warning
  });
});
