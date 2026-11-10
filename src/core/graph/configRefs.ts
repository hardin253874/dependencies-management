/**
 * Package references inside known config files (D3, design §4.1,
 * V2_STAGE3_SPEC 3a.6). Configs are read as data — JS/TS through the Babel
 * AST, JSON as JSONC, YAML by line regex — and never executed.
 *
 * Confidence:
 *  - `medium`: the string (or object key) is exactly a declared dependency;
 *  - `low`: reached through a tool's shorthand (`plugins: ['react']` →
 *    `eslint-plugin-react`, `'@babel/env'` → `@babel/preset-env`,
 *    `'module:pkg'`), a conventional name that is not declared
 *    (`babel-plugin-x`), or anything read from YAML.
 * In plugin/preset/extends positions the tool's expansion wins over an exact
 * match (`eslint plugins: ['react']` means eslint-plugin-react, not react).
 */
import { packageNameFromSpecifier } from '../../lib/scanners/code';
import type { ConfigFileInfo, ConfigTool } from './configFiles';
import { isRecord, parseJsonc } from './jsonc';
import { parseAst, traverseAst } from './parse';
import type { Confidence } from './types';

export interface ConfigRef {
  packageName: string;
  /** The string as written in the config. */
  specifier: string;
  confidence: Confidence;
  line: number;
  col: number;
  snippet: string;
}

export interface ExtractConfigRefsOptions {
  relPath: string;
  source: string;
  info: ConfigFileInfo;
  declared: readonly string[];
}

type Slot = 'plugin' | 'preset' | 'extends' | 'types' | 'other';

const CONVENTION_RE =
  /^(?:@[\w.-]+\/)?(?:babel-(?:plugin|preset)-|eslint-(?:plugin|config)-|postcss-|prettier-plugin-|stylelint-|jest-(?:environment|preset)-)[\w.-]+$|^@babel\/(?:plugin|preset)-[\w.-]+$|^@[\w.-]+\/(?:eslint-plugin|eslint-config|babel-preset|babel-plugin)$/;

/** Subtrees of package.json that are tool configs (spec 3a.6). */
const PACKAGE_JSON_KEYS: readonly string[] = Object.freeze(['babel', 'eslintConfig', 'jest', 'prettier']);
const PACKAGE_JSON_TOOL: Readonly<Record<string, ConfigTool>> = Object.freeze({
  babel: 'babel',
  eslintConfig: 'eslint',
  jest: 'jest',
  prettier: 'prettier'
});

function slotOf(key: string | null): Slot {
  if (key === 'plugins') return 'plugin';
  if (key === 'presets' || key === 'preset') return 'preset';
  if (key === 'extends') return 'extends';
  if (key === 'types') return 'types';
  return 'other';
}

function splitScoped(s: string): { scope: string | null; name: string | null } {
  if (!s.startsWith('@')) return { scope: null, name: s };
  const slash = s.indexOf('/');
  return slash === -1 ? { scope: s, name: null } : { scope: s.slice(0, slash), name: s.slice(slash + 1) };
}

function eslintPlugin(s: string): string {
  const { scope, name } = splitScoped(s);
  if (scope === null) return name!.startsWith('eslint-plugin-') ? name! : `eslint-plugin-${name!}`;
  if (name === null) return `${scope}/eslint-plugin`;
  return name.startsWith('eslint-plugin') ? s : `${scope}/eslint-plugin-${name}`;
}

function eslintConfig(s: string): string | null {
  if (s.startsWith('eslint:') || s.startsWith('.') || s.startsWith('/')) return null;
  if (s.startsWith('plugin:')) {
    const body = s.slice('plugin:'.length);
    const last = body.lastIndexOf('/');
    if (last <= 0) return null;
    return eslintPlugin(body.slice(0, last));
  }
  const pkg = packageNameFromSpecifier(s) ?? s;
  const { scope, name } = splitScoped(pkg);
  if (scope === null) return name!.startsWith('eslint-config-') ? name! : `eslint-config-${name!}`;
  if (name === null) return `${scope}/eslint-config`;
  return name.startsWith('eslint-config') ? pkg : `${scope}/eslint-config-${name}`;
}

function babelName(s: string, slot: 'plugin' | 'preset'): string | null {
  if (s.startsWith('.') || s.startsWith('/')) return null;
  const { scope, name } = splitScoped(s);
  if (scope === '@babel' && name !== null) return name.startsWith(`${slot}-`) ? s : `@babel/${slot}-${name}`;
  if (scope !== null) {
    if (name === null) return `${scope}/babel-${slot}`;
    return name.startsWith(`babel-${slot}`) ? s : `${scope}/babel-${slot}-${name}`;
  }
  return name!.startsWith(`babel-${slot}-`) ? name! : `babel-${slot}-${name!}`;
}

/** Tool-specific shorthand expansion for a slot; null when the tool has no shorthand there. */
function expand(tool: ConfigTool, slot: Slot, s: string): string | null {
  if (tool === 'eslint' && slot === 'plugin') return eslintPlugin(s);
  if (tool === 'eslint' && slot === 'extends') return eslintConfig(s);
  if (tool === 'babel' && (slot === 'plugin' || slot === 'preset')) return babelName(s, slot);
  if (tool === 'tsconfig' && slot === 'types') return s.startsWith('@') ? `@types/${s.slice(1).replace('/', '__')}` : `@types/${s.split('/')[0]!}`;
  return null;
}

function classify(tool: ConfigTool, slot: Slot, raw: string, declared: readonly string[]): { name: string; confidence: Confidence } | null {
  const s = raw.trim();
  if (s === '' || s.length > 214 || /\s/.test(s)) return null;
  if (s.startsWith('module:')) {
    const pkg = packageNameFromSpecifier(s.slice('module:'.length));
    return pkg === null ? null : { name: pkg, confidence: 'low' };
  }
  const expanded = expand(tool, slot, s);
  if (expanded !== null) {
    const pkg = packageNameFromSpecifier(expanded);
    const exactPkg = packageNameFromSpecifier(s);
    if (pkg !== null && declared.includes(pkg)) return { name: pkg, confidence: pkg === exactPkg ? 'medium' : 'low' };
  }
  const exact = packageNameFromSpecifier(s);
  if (exact !== null && declared.includes(exact)) return { name: exact, confidence: 'medium' };
  if (exact !== null && CONVENTION_RE.test(exact)) return { name: exact, confidence: 'low' };
  return null;
}

interface Candidate {
  value: string;
  key: string | null;
  line: number;
  col: number;
}

function jsCandidates(source: string): Candidate[] {
  const ast = parseAst(source);
  if (ast === null) return [];
  const out: Candidate[] = [];
  const nearestKey = (p: { parentPath: unknown }): string | null => {
    let cur = p.parentPath as { node?: { type: string; key?: { type: string; name?: string; value?: string } }; parentPath?: unknown } | null;
    while (cur !== null && cur !== undefined && cur.node !== undefined) {
      const n = cur.node;
      if (n.type === 'ObjectProperty' && n.key !== undefined) {
        if (n.key.type === 'Identifier') return n.key.name ?? null;
        if (n.key.type === 'StringLiteral') return n.key.value ?? null;
        return null;
      }
      if (n.type !== 'ArrayExpression' && n.type !== 'ObjectExpression') return null;
      cur = cur.parentPath as typeof cur;
    }
    return null;
  };
  try {
    traverseAst(ast, {
      StringLiteral(p) {
        const parent = p.parentPath.node;
        // Import/require specifiers are ordinary edges, not config refs.
        if (parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration' || parent.type === 'ExportNamedDeclaration') return;
        if (parent.type === 'CallExpression' && parent.arguments[0] === p.node) {
          const c = parent.callee;
          if ((c.type === 'Identifier' && c.name === 'require') || c.type === 'Import') return;
        }
        // An object key is collected by the ObjectProperty visitor below.
        if (parent.type === 'ObjectProperty' && parent.key === p.node) return;
        out.push({ value: p.node.value, key: nearestKey(p), line: p.node.loc?.start.line ?? 0, col: p.node.loc?.start.column ?? 0 });
      },
      ObjectProperty(p) {
        const k = p.node.key;
        const value = !p.node.computed && k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : null;
        if (value === null) return;
        // A key's slot is its parent's key: `plugins: { tailwindcss: {} }` → slot plugin.
        out.push({ value, key: nearestKey(p), line: k.loc?.start.line ?? 0, col: k.loc?.start.column ?? 0 });
      }
    });
  } catch {
    return out;
  }
  return out;
}

/** Strings and keys of a JSON document in document order, with positions found by a forward cursor. */
function jsonCandidates(source: string, json: unknown, allowedRoots: readonly string[] | null): Array<Candidate & { root: string | null }> {
  const out: Array<Candidate & { root: string | null }> = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  let cursor = 0;
  const locate = (s: string): { line: number; col: number } => {
    const needle = JSON.stringify(s);
    const at = source.indexOf(needle, cursor);
    if (at === -1) return { line: 0, col: 0 };
    cursor = at + needle.length;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: at - lineStarts[lo]! };
  };
  const walk = (v: unknown, key: string | null, root: string | null, emit: boolean) => {
    if (typeof v === 'string') {
      const pos = locate(v);
      if (emit) out.push({ value: v, key, root, ...pos });
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, root, emit);
    } else if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) {
        const pos = locate(k);
        const childRoot = root ?? (allowedRoots === null ? null : k);
        const childEmit = emit || (allowedRoots !== null && root === null && allowedRoots.includes(k));
        if (childEmit && root !== null) out.push({ value: k, key, root, ...pos });
        walk(x, k, childRoot, childEmit);
      }
    }
  };
  walk(json, null, null, allowedRoots === null);
  return out;
}

/** tsconfig: only `extends`, `compilerOptions.types` and `compilerOptions.plugins[].name` name packages. */
function tsconfigCandidates(source: string, json: unknown): Candidate[] {
  const all = jsonCandidates(source, json, null);
  if (!isRecord(json)) return [];
  const co = isRecord(json.compilerOptions) ? json.compilerOptions : {};
  const types = Array.isArray(co.types) ? co.types.filter((x): x is string => typeof x === 'string') : [];
  const plugins = Array.isArray(co.plugins)
    ? co.plugins.flatMap((p) => (isRecord(p) && typeof p.name === 'string' ? [p.name] : []))
    : [];
  const ext = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
  return all.filter(
    (c) =>
      (c.key === 'types' && types.includes(c.value)) ||
      (c.key === 'name' && plugins.includes(c.value)) ||
      (c.key === 'extends' && ext.includes(c.value))
  );
}

function yamlCandidates(source: string): Candidate[] {
  const out: Candidate[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  source.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (line.trim() === '') return;
    const indent = line.length - line.trimStart().length;
    const item = /^\s*-\s*(.+)$/.exec(line);
    const kv = /^\s*(['"]?)([\w@./:-]+)\1\s*:\s*(.*)$/.exec(item?.[1] ?? line);
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent && item === null) stack.pop();
    const parentKey = stack.length > 0 ? stack[stack.length - 1]!.key : null;
    const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
    if (item !== null && kv === null) {
      out.push({ value: unquote(item[1]!), key: parentKey, line: i + 1, col: indent });
      return;
    }
    if (kv !== null) {
      const key = kv[2]!;
      out.push({ value: key, key: parentKey, line: i + 1, col: indent });
      const value = unquote(kv[3] ?? '');
      if (value !== '' && !value.startsWith('[') && !value.startsWith('{')) out.push({ value, key, line: i + 1, col: indent });
      if (item === null) stack.push({ indent, key });
    }
  });
  return out;
}

export function extractConfigRefs(opts: ExtractConfigRefsOptions): ConfigRef[] {
  const { info, source, declared } = opts;
  const lines = source.split('\n');
  const refs: ConfigRef[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate, tool: ConfigTool, forceLow: boolean) => {
    const hit = classify(tool, slotOf(c.key), c.value, declared);
    if (hit === null) return;
    const dedupe = `${hit.name}\0${c.line}\0${c.value}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    refs.push({
      packageName: hit.name,
      specifier: c.value,
      confidence: forceLow ? 'low' : hit.confidence,
      line: c.line,
      col: c.col,
      snippet: (lines[c.line - 1] ?? '').trim().slice(0, 200)
    });
  };

  if (info.format === 'js') {
    for (const c of jsCandidates(source)) add(c, info.tool, false);
  } else if (info.format === 'yaml') {
    for (const c of yamlCandidates(source)) add(c, info.tool, true);
  } else {
    const json = parseJsonc(source);
    if (json === null) return [];
    if (info.tool === 'package') {
      for (const c of jsonCandidates(source, json, PACKAGE_JSON_KEYS)) {
        const tool = c.root === null ? null : PACKAGE_JSON_TOOL[c.root];
        if (tool !== undefined && tool !== null) add(c, tool, false);
      }
    } else if (info.tool === 'tsconfig') {
      for (const c of tsconfigCandidates(source, json)) add(c, 'tsconfig', false);
    } else {
      for (const c of jsonCandidates(source, json, null)) add(c, info.tool, false);
    }
  }
  refs.sort((a, b) => a.line - b.line || a.col - b.col);
  return refs;
}
