/**
 * Route guards. Wraps a Route Handler with CSRF + JSON-body parsing + request
 * logging.
 */
import { NextResponse } from 'next/server';
import { checkCsrf } from '../csrf';
import { logRequest } from '../logger';
import { badRequest, forbidden } from './errors';

export type Handler<C> = (req: Request, ctx: C) => Promise<NextResponse> | NextResponse;

/**
 * Wrap a Route Handler with request logging. Logs method + path + status +
 * duration to `library/_logs/server.log` (and pretty console in dev) after
 * the handler returns. Errors thrown by the handler are logged at level
 * `error` then re-thrown for Next.js to render the 500 page.
 *
 * Use directly on GET routes; mutating routes get this for free via `withCsrf`
 * (which composes with `withRequestLog` internally).
 */
export function withRequestLog<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const startedAt = Date.now();
    const method = req.method;
    // `req.url` is absolute on Next.js Route Handlers; strip the origin so logs
    // don't carry the loopback host on every line.
    const url = stripOrigin(req.url);
    try {
      const res = await handler(req, ctx);
      void logRequest(method, url, res.status, Date.now() - startedAt);
      return res;
    } catch (err) {
      void logRequest(method, url, 500, Date.now() - startedAt, {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  };
}

function stripOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Wraps a handler that mutates state. Rejects requests without a valid
 * X-Local-Token header. Composes `withRequestLog` so every mutation gets
 * logged whether the CSRF check passes or fails.
 */
export function withCsrf<C>(handler: Handler<C>): Handler<C> {
  return withRequestLog<C>(async (req, ctx) => {
    const check = checkCsrf(req.headers);
    if (!check.ok) {
      return forbidden('CSRF_REJECTED', check.reason ?? 'CSRF token missing or invalid.');
    }
    return handler(req, ctx);
  });
}

/**
 * Parse a JSON body. Returns the parsed value or a NextResponse error.
 */
export async function readJsonBody<T = unknown>(req: Request): Promise<T | NextResponse> {
  try {
    return (await req.json()) as T;
  } catch {
    return badRequest('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}
