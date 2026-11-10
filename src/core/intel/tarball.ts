/**
 * Minimal in-memory reader for npm package tarballs (.tgz), used by `api_diff`
 * (V2_STAGE4_SPEC 4a.4). Keeps only type-definition files and package.json
 * files; never writes anything to disk, never runs anything (lifecycle scripts
 * in the tarball are just bytes we skip).
 *
 * Why own code instead of `tar`: we need ~60 lines of the ustar format (plus
 * PAX/GNU long names), extraction to memory only, and strict entry checks;
 * `tar` is only a transitive dependency (via pacote) and writes to disk by
 * design.
 */
import zlib from 'zlib';

export const TARBALL_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
export const TYPES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export class TarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarballError';
  }
}

const KEEP_RE = /(\.d\.ts|\.d\.mts|\.d\.cts|(^|\/)package\.json)$/;

function cstr(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function sizeOf(header: Buffer): number {
  const field = header.subarray(124, 136);
  // GNU base-256 encoding for sizes ≥ 8 GiB: refuse, nothing we read is that big.
  if ((field[0]! & 0x80) !== 0) throw new TarballError('tar entry too large');
  const n = Number.parseInt(cstr(header, 124, 136).trim() || '0', 8);
  if (!Number.isFinite(n) || n < 0) throw new TarballError('bad tar entry size');
  return n;
}

function paxPath(data: Buffer): string | null {
  let off = 0;
  const text = data.toString('utf8');
  while (off < text.length) {
    const space = text.indexOf(' ', off);
    if (space === -1) break;
    const len = Number.parseInt(text.slice(off, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, off + len - 1);
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    off += len;
  }
  return null;
}

/**
 * Entry path inside the package: the first segment (`package/` for npm, the
 * name for some `@types` tarballs) is dropped. Throws on traversal / absolute
 * paths so a hostile tarball is refused as a whole.
 */
export function entryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new TarballError(`tarball entry refused (absolute path): ${p.slice(0, 100)}`);
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new TarballError(`tarball entry refused (".." segment): ${p.slice(0, 100)}`);
  if (segs.length < 2) return null;
  return segs.slice(1).join('/');
}

/** Returns path → text for every type-definition / package.json file in the tarball. */
export function readTypesFromTarball(tgz: Uint8Array): Map<string, string> {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(Buffer.from(tgz), { maxOutputLength: TARBALL_MAX_UNPACKED_BYTES });
  } catch (err) {
    throw new TarballError(`tarball could not be unpacked: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out = new Map<string, string>();
  let total = 0;
  let longName: string | null = null;
  let pax: string | null = null;
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = sizeOf(header);
    const type = String.fromCharCode(header[156]!);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = paxPath(data);
      continue;
    }
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const magic = cstr(header, 257, 263);
    const prefix = magic.startsWith('ustar') ? cstr(header, 345, 500) : '';
    const name = longName ?? pax ?? (prefix !== '' ? `${prefix}/${cstr(header, 0, 100)}` : cstr(header, 0, 100));
    longName = null;
    pax = null;
    const rel = entryPath(name);
    if (rel === null) continue;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (!KEEP_RE.test(rel)) continue;
    total += size;
    if (total > TYPES_MAX_TOTAL_BYTES) throw new TarballError('type definitions exceed the 20 MB cap');
    out.set(rel, data.toString('utf8'));
  }
  return out;
}
