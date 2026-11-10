/**
 * Builds tiny npm-style .tgz tarballs in memory for `api_diff` tests
 * (ustar headers, gzip). Test-only; nothing touches the network.
 */
import zlib from 'node:zlib';

export interface TarEntry {
  name: string;
  content: string;
  /** '0' file (default), '5' directory. */
  type?: '0' | '5';
}

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

export function makeTgz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content, 'utf8');
    parts.push(header(e.name, body.length, e.type ?? '0'));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** A package tarball with files under `package/`. */
export function packageTgz(files: Record<string, string>): Buffer {
  return makeTgz(Object.entries(files).map(([name, content]) => ({ name: `package/${name}`, content })));
}
