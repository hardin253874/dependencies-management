/**
 * Direct-file JSON-line logger. Spec §10.11.
 *
 * Why custom instead of pino:
 *   The previous pino-based implementation used `transport: { targets: [...] }`
 *   which spawns a worker thread to serialise log I/O. On Windows + Next.js
 *   dev mode that worker is fragile: it can be killed during HMR reloads,
 *   crash silently if `pino-pretty` fails to resolve from its worker context,
 *   or be left dangling after a route handler errors. When the worker dies,
 *   the main `log.info()` calls return without writing anything — there's no
 *   surface error, the `_logs/server.log` file just stops growing.
 *
 *   For a single-process local-only tool we don't need the throughput of a
 *   worker thread. Direct `fs.appendFile` is fast enough (<1ms per line in
 *   practice) and is robust against HMR. This module appends one JSON line
 *   per log call, serialised through an in-process mutex so concurrent
 *   route handlers don't interleave half-written lines.
 *
 * Why `globalThis`: Next.js dev mode evaluates this module per-route bundle,
 * so a module-scoped `let logger` would mean every handler gets its own
 * mutex chain — concurrent writes from different routes could still
 * interleave. Stashing on `globalThis` pins one mutex per Node process.
 * Same pattern as `csrf.ts`, `queue.ts`, etc.
 *
 * LOG_LEVEL from .env, default 'info'.
 */
import { promises as fs } from 'fs';
import { loadEnv } from './config';
import { logsDir, serverLogPath } from './paths';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LEVEL_NUMERIC: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
};

type LogCall = (objOrMsg: unknown, msg?: string) => void;

export interface Logger {
  trace: LogCall;
  debug: LogCall;
  info: LogCall;
  warn: LogCall;
  error: LogCall;
  fatal: LogCall;
  child: (bindings: Record<string, unknown>) => Logger;
}

interface LoggerState {
  level: LogLevel;
  /** Resolved destination path; captured once and never re-evaluated. */
  destination: string;
  /** Serialises appends so concurrent calls don't interleave. */
  writeChain: Promise<void>;
  bindings: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_LOGGER_STATE__: LoggerState | undefined;
  // eslint-disable-next-line no-var
  var __DEP_AGENT_LOGGER__: Logger | undefined;
}

async function makeState(): Promise<LoggerState> {
  const env = loadEnv();
  await fs.mkdir(logsDir(), { recursive: true });
  return {
    level: env.logLevel as LogLevel,
    destination: serverLogPath(),
    writeChain: Promise.resolve(),
    bindings: {}
  };
}

function makeLogger(state: LoggerState, extraBindings: Record<string, unknown> = {}): Logger {
  const bindings = { ...state.bindings, ...extraBindings };
  const isProd = process.env.NODE_ENV === 'production';

  const emit = (level: LogLevel, objOrMsg: unknown, msg?: string): void => {
    if (LEVEL_NUMERIC[level] < LEVEL_NUMERIC[state.level]) return;

    let payload: Record<string, unknown>;
    let message: string | undefined;
    if (typeof objOrMsg === 'string') {
      payload = {};
      message = objOrMsg;
    } else if (objOrMsg !== null && typeof objOrMsg === 'object') {
      payload = { ...(objOrMsg as Record<string, unknown>) };
      message = msg;
    } else {
      payload = {};
      message = msg ?? String(objOrMsg);
    }

    const line = JSON.stringify({
      level: LEVEL_NUMERIC[level],
      time: Date.now(),
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? '',
      ...bindings,
      ...payload,
      msg: message ?? ''
    });

    // Pretty-print to console in dev. Use console.error for warn+ so it
    // surfaces in red, console.log otherwise.
    if (!isProd) {
      const stamp = new Date().toISOString().slice(11, 23);
      const tag = `[${level.toUpperCase()}]`;
      const head = `${stamp} ${tag} ${message ?? ''}`;
      if (LEVEL_NUMERIC[level] >= 40) console.error(head, payload);
      else console.log(head, payload);
    }

    // Serialise appends through the per-process chain. Any rejection is
    // swallowed — logging must never throw into a request.
    state.writeChain = state.writeChain.then(
      () => fs.appendFile(state.destination, line + '\n', 'utf8').catch(() => undefined),
      () => fs.appendFile(state.destination, line + '\n', 'utf8').catch(() => undefined)
    );
  };

  return {
    trace: (o, m) => emit('trace', o, m),
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
    fatal: (o, m) => emit('fatal', o, m),
    child: (childBindings) => makeLogger(state, { ...extraBindings, ...childBindings })
  };
}

export async function getLogger(): Promise<Logger> {
  if (globalThis.__DEP_AGENT_LOGGER__ !== undefined) {
    return globalThis.__DEP_AGENT_LOGGER__;
  }
  let state = globalThis.__DEP_AGENT_LOGGER_STATE__;
  if (state === undefined) {
    state = await makeState();
    globalThis.__DEP_AGENT_LOGGER_STATE__ = state;
  }
  const logger = makeLogger(state);
  globalThis.__DEP_AGENT_LOGGER__ = logger;
  return logger;
}

/**
 * Synchronous variant — best-effort. Returns a no-op logger if the cached
 * state isn't ready yet (first call still has to be `getLogger` to mkdir +
 * resolve the destination). Useful in places where awaiting would be awkward
 * (e.g. fire-and-forget progress logs inside a hot scan loop).
 */
export function getLoggerSync(): Logger | null {
  return globalThis.__DEP_AGENT_LOGGER__ ?? null;
}

/** For tests: reset cached logger + state. */
export function resetLogger(): void {
  globalThis.__DEP_AGENT_LOGGER__ = undefined;
  globalThis.__DEP_AGENT_LOGGER_STATE__ = undefined;
}

/**
 * Log a single API request. Called by `withRequestLog` / `withCsrf` so the
 * `_logs/server.log` file gets populated during normal use, not just on
 * errors. Writes a structured line like:
 *
 *   { level: 30, time: ..., msg: 'POST /api/projects 202 (84ms)',
 *     method: 'POST', url: '/api/projects', status: 202, durationMs: 84 }
 *
 * Never throws — logging failures must not surface to the user.
 */
export async function logRequest(
  method: string,
  url: string,
  status: number,
  durationMs: number,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    const log = await getLogger();
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    log[level](
      { method, url, status, durationMs, ...extra },
      `${method} ${url} ${status} (${durationMs}ms)`
    );
  } catch {
    // Swallow — logging must never break a request.
  }
}
