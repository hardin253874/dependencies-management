/**
 * `read_file` + `search_code` (V2_STAGE4_SPEC 4a.3). Bounded code reading
 * inside `workspaceRoot`, read-only by construction: the only fs calls are
 * `realpath` (path guard) and `readFile`. Every path goes through `pathGuard`
 * first, so `.env*`, traversal and files outside the graph are refused before
 * any fs call.
 *
 * `search_code` is a literal substring search (no user regex → no ReDoS) over
 * the graph file set only.
 */
import { promises as fs } from 'fs';
import { graphFileSet, pathGuard } from '../pathGuard';
import { ToolError, type AgentToolDef } from '../types';

export const READ_FILE_MAX_LINES = 400;
export const READ_FILE_MAX_BYTES = 32 * 1024;
/** 32 KB of text plus JSON escaping and the envelope fields. */
export const READ_FILE_RESULT_MAX_BYTES = 48 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
export const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SEARCH_MAX_MATCHES = 200;
export const SEARCH_MAX_FILES = 2_000;
export const SNIPPET_MAX_CHARS = 200;
const SEARCH_DEFAULT_LIMIT = 50;

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function snippetOf(line: string): string {
  const t = line.trim();
  return t.length <= SNIPPET_MAX_CHARS ? t : `${t.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

export function fileTools(): AgentToolDef[] {
  return [
    {
      name: 'read_file',
      description: `Read a line range of a project source file (max ${READ_FILE_MAX_LINES} lines / 32 KB per call, numbered "N| ..."). Only files in the project graph and package.json files can be read.`,
      capability: 'read',
      maxResultBytes: READ_FILE_RESULT_MAX_BYTES,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Project-relative POSIX path, e.g. "src/index.ts".', maxLength: 1024 },
          start_line: { type: 'integer', description: '1-based first line (default 1).', minimum: 1 },
          end_line: { type: 'integer', description: `Last line, inclusive (default start_line + ${READ_FILE_MAX_LINES - 1}).`, minimum: 1 }
        }
      },
      handler: async (ctx, input) => {
        const guarded = await pathGuard(ctx.workspaceRoot, input.path, graphFileSet(ctx.graph));
        const buf = await fs.readFile(guarded.abs);
        if (isBinary(buf)) throw new ToolError(`binary file: ${guarded.rel}`);
        const lines = splitLines(buf.toString('utf8'));
        const start = typeof input.start_line === 'number' ? input.start_line : 1;
        if (start > Math.max(1, lines.length)) throw new ToolError(`start_line ${start} is past the end (${lines.length} lines)`);
        const askedEnd = typeof input.end_line === 'number' ? input.end_line : start + READ_FILE_MAX_LINES - 1;
        if (askedEnd < start) throw new ToolError('end_line must be >= start_line');
        const end = Math.min(askedEnd, start + READ_FILE_MAX_LINES - 1, lines.length);
        const out: string[] = [];
        let bytes = 0;
        let last = start - 1;
        for (let n = start; n <= end; n += 1) {
          const row = `${n}| ${lines[n - 1] ?? ''}`;
          const rowBytes = Buffer.byteLength(row, 'utf8') + 1;
          if (bytes + rowBytes > READ_FILE_MAX_BYTES) break;
          out.push(row);
          bytes += rowBytes;
          last = n;
        }
        return {
          path: guarded.rel,
          startLine: start,
          endLine: last,
          totalLines: lines.length,
          text: out.join('\n'),
          ...(last < lines.length ? { more: `continue with start_line ${last + 1}` } : {})
        };
      }
    },
    {
      name: 'search_code',
      description:
        'Literal (non-regex) text search over the project source files in the graph. Returns path, line and a one-line snippet per match. Use path_prefix / file_kinds to narrow.',
      capability: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Literal text to find (min 2 characters).', maxLength: 200 },
          path_prefix: { type: 'string', description: 'Only files under this project-relative POSIX prefix.', maxLength: 1024 },
          file_kinds: { type: 'array', items: { type: 'string', enum: ['js', 'style', 'config'] }, maxItems: 3, description: 'Restrict to file kinds.' },
          case_sensitive: { type: 'boolean', description: 'Default false.' },
          limit: { type: 'integer', description: `Max matches (default ${SEARCH_DEFAULT_LIMIT}).`, minimum: 1, maximum: SEARCH_MAX_MATCHES }
        }
      },
      handler: async (ctx, input) => {
        const query = String(input.query);
        if (query.trim().length < 2) throw new ToolError('query must have at least 2 non-space characters');
        const caseSensitive = input.case_sensitive === true;
        const needle = caseSensitive ? query : query.toLowerCase();
        const limit = typeof input.limit === 'number' ? input.limit : SEARCH_DEFAULT_LIMIT;
        const prefix = typeof input.path_prefix === 'string' ? input.path_prefix.replace(/\\/g, '/').replace(/^\.\//, '') : '';
        const kinds = Array.isArray(input.file_kinds) ? (input.file_kinds as string[]) : null;
        const files = [...graphFileSet(ctx.graph).values()]
          .filter((f) => f.path.startsWith(prefix) && (kinds === null || kinds.includes(f.kind)) && f.size <= SEARCH_MAX_FILE_BYTES)
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const matches: Array<{ path: string; line: number; snippet: string }> = [];
        let filesSearched = 0;
        let capped = false;
        const allowed = new Map(files.map((f) => [f.path, f]));
        for (const f of files) {
          if (ctx.signal?.aborted === true) throw new ToolError('cancelled');
          if (filesSearched >= SEARCH_MAX_FILES) {
            capped = true;
            break;
          }
          let abs: string;
          try {
            abs = (await pathGuard(ctx.workspaceRoot, f.path, allowed)).abs;
          } catch {
            continue;
          }
          const buf = await fs.readFile(abs).catch(() => null);
          filesSearched += 1;
          if (buf === null || isBinary(buf)) continue;
          const lines = splitLines(buf.toString('utf8'));
          for (let i = 0; i < lines.length; i += 1) {
            const hay = caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
            if (!hay.includes(needle)) continue;
            matches.push({ path: f.path, line: i + 1, snippet: snippetOf(lines[i]!) });
            if (matches.length >= limit) break;
          }
          if (matches.length >= limit) {
            capped = true;
            break;
          }
        }
        return { query, matches, filesSearched, filesInScope: files.length, capped };
      }
    }
  ];
}
