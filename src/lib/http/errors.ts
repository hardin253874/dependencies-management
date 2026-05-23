/**
 * Standard HTTP error envelope (spec §9.5).
 *
 *   { "error": { "code", "message", "retryable" } }
 */
import { NextResponse } from 'next/server';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  retryable = false
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, retryable } },
    { status }
  );
}

export function badRequest(code: string, message: string): NextResponse<ApiErrorBody> {
  return jsonError(400, code, message);
}

export function notFound(code: string, message: string): NextResponse<ApiErrorBody> {
  return jsonError(404, code, message);
}

export function forbidden(code: string, message: string): NextResponse<ApiErrorBody> {
  return jsonError(403, code, message);
}

export function conflict(code: string, message: string): NextResponse<ApiErrorBody> {
  return jsonError(409, code, message);
}

export function internalError(code: string, message: string): NextResponse<ApiErrorBody> {
  return jsonError(500, code, message);
}
