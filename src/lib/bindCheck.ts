/**
 * Local-only bind invariant (spec §3.3, §10).
 *
 * The server must bind to 127.0.0.1 only — never 0.0.0.0 or any external
 * interface. This module enforces that invariant in two places:
 *
 *   1. The npm scripts pass `-H 127.0.0.1` to `next dev` / `next start`.
 *   2. At runtime, if HOSTNAME / HOST env vars override the bind to anything
 *      other than 127.0.0.1 / localhost, throw at boot.
 *
 * The npm scripts are checked by getBoundHost(); we expose pure functions so
 * tests can assert the invariant without spinning up a real server.
 */

const SAFE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true; // unset = node default
  return SAFE_HOSTS.has(host.toLowerCase());
}

/**
 * Read the bind args from the active npm script (NPM_LIFECYCLE_EVENT +
 * npm_lifecycle_script) and from HOST / HOSTNAME env vars. Returns the
 * effective host the Next.js server will listen on.
 */
export function getBoundHost(): string {
  const script = process.env.npm_lifecycle_script ?? '';
  const match = script.match(/-H\s+(\S+)/);
  if (match !== null) return match[1]!;
  if (process.env.HOSTNAME !== undefined && process.env.HOSTNAME !== '') return process.env.HOSTNAME;
  if (process.env.HOST !== undefined && process.env.HOST !== '') return process.env.HOST;
  return '127.0.0.1';
}

export function assertLoopbackBind(): void {
  const host = getBoundHost();
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind to ${host}. The Dependencies Management Agent is local-only; ` +
        `the server must bind to 127.0.0.1 (spec §3.3).`
    );
  }
}
