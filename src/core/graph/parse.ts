/**
 * JS/TS parsing for the graph (V2_STAGE3_SPEC 3a.4, design §4), behind a
 * `ParserAdapter` so the parser choice stays reversible (proposed D19).
 *
 * Babel options are identical to v1 `parseImports` (src/lib/scanners/code.ts),
 * so every file v1 could parse stays parseable. Scope analysis comes from
 * `@babel/traverse` (binding.referencePaths), which excludes shadowed names.
 *
 * Never executes anything: the source text is only parsed.
 */
import { createRequire } from 'module';
import path from 'path';
import type * as BabelParser from '@babel/parser';
import type { NodePath, Binding, TraverseOptions } from '@babel/traverse';
import type * as t from '@babel/types';
import type { EdgeKind, FileRole, UsageKind } from './types';

// Same CJS-loading pattern as code.ts: a static createRequire keeps parse()
// synchronous and works under Turbopack (both packages are in
// serverExternalPackages), Vitest and vite-node.
const requireFn = createRequire(import.meta.url);
const babel = requireFn('@babel/parser') as typeof BabelParser;
const traverseMod = requireFn('@babel/traverse') as { default: (ast: t.Node, opts: TraverseOptions) => void };
const traverse = traverseMod.default;

export const BABEL_PARSER_VERSION = '7.24.7';

export interface ParsedBinding {
  local: string;
  /** 'default', a named export, or '*' for a namespace / whole module. */
  imported: string;
  isType: boolean;
}

export interface ParsedImport {
  /** null for `dynamic-expr` (the argument is not a literal). */
  specifier: string | null;
  kind: EdgeKind;
  bindings: ParsedBinding[];
  line: number;
  col: number;
  snippet: string;
  /** True for `typeof import('x')` / `import('x').T` type positions (v1 never saw these). */
  viaTypeQuery?: boolean;
}

export interface ParsedReexport {
  /** Index into `ParsedFile.imports` of the edge this re-export goes through. */
  importIndex: number;
  /** Exported name, or '*' for `export * from`. */
  exported: string;
  /** Imported name in the target module, '*' for the whole module. */
  imported: string;
}

export interface ParsedUsage {
  importIndex: number;
  local: string;
  imported: string;
  member: string | null;
  kind: UsageKind;
  line: number;
  col: number;
  snippet: string;
}

export interface ParsedFile {
  imports: ParsedImport[];
  /** Locally declared export names (incl. 'default'); re-exports are in `reexports`. */
  exports: string[];
  reexports: ParsedReexport[];
  usages: ParsedUsage[];
  /** Any ESM export, re-export, `export =`, `module.exports` or `exports.x`. */
  hasExports: boolean;
  parseError: string | null;
}

export interface ParserAdapter {
  /** `<name>@<version>`, stored in `meta.parser`; a change forces a full rebuild. */
  readonly id: string;
  parse(source: string, relPosixPath: string): ParsedFile;
}

const BABEL_OPTIONS: BabelParser.ParserOptions = {
  sourceType: 'unambiguous',
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  errorRecovery: true,
  plugins: [
    'typescript',
    'jsx',
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'dynamicImport',
    'importMeta',
    'topLevelAwait'
  ]
};

const USAGE_SNIPPET_MAX = 200;
// Import snippets feed v1-compatible `importStatements`; capped only so a
// one-line bundle cannot bloat the DB.
const IMPORT_SNIPPET_MAX = 1000;

function emptyResult(parseError: string | null): ParsedFile {
  return { imports: [], exports: [], reexports: [], usages: [], hasExports: false, parseError };
}

function lineText(lines: string[], line: number, max: number): string {
  const text = (lines[line - 1] ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function exportedNameOf(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value;
}

function literalSpecifier(arg: t.Node | undefined): { value: string; template: boolean } | null {
  if (arg === undefined) return null;
  if (arg.type === 'StringLiteral') return { value: arg.value, template: false };
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0 && arg.quasis.length === 1) {
    const cooked = arg.quasis[0]?.value.cooked;
    if (typeof cooked === 'string') return { value: cooked, template: true };
  }
  return null;
}

interface PendingExport {
  local: string;
  exported: string;
  binding: Binding | undefined;
}

function parseBabel(source: string, relPosixPath: string): ParsedFile {
  let ast: t.File;
  try {
    ast = babel.parse(source, BABEL_OPTIONS) as unknown as t.File;
  } catch (err) {
    return emptyResult(err instanceof Error ? err.message : String(err));
  }

  const lines = source.split('\n');
  const imports: ParsedImport[] = [];
  const exports: string[] = [];
  const reexports: ParsedReexport[] = [];
  const pendingExports: PendingExport[] = [];
  const bindingOwners = new Map<Binding, { importIndex: number; imported: string; local: string }>();
  let cjsExports = false;

  const addImport = (imp: ParsedImport): number => {
    imports.push(imp);
    return imports.length - 1;
  };
  const pos = (node: t.Node) => ({ line: node.loc?.start.line ?? 0, col: node.loc?.start.column ?? 0 });
  const own = (scopePath: NodePath, importIndex: number, local: string, imported: string) => {
    const binding = scopePath.scope.getBinding(local);
    if (binding !== undefined) bindingOwners.set(binding, { importIndex, imported, local });
  };

  const visitor: TraverseOptions = {
    ImportDeclaration(p) {
      const node = p.node;
      const { line, col } = pos(node);
      const specs = node.specifiers;
      const allType =
        node.importKind === 'type' ||
        (specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type'));
      const bindings: ParsedBinding[] = specs.map((s) => {
        if (s.type === 'ImportDefaultSpecifier') return { local: s.local.name, imported: 'default', isType: allType };
        if (s.type === 'ImportNamespaceSpecifier') return { local: s.local.name, imported: '*', isType: allType };
        return {
          local: s.local.name,
          imported: exportedNameOf(s.imported),
          isType: allType || s.importKind === 'type'
        };
      });
      const kind: EdgeKind = allType ? 'type-only' : specs.length === 0 ? 'side-effect' : 'static';
      const idx = addImport({
        specifier: node.source.value,
        kind,
        bindings,
        line,
        col,
        snippet: lineText(lines, line, IMPORT_SNIPPET_MAX)
      });
      for (const b of bindings) own(p, idx, b.local, b.imported);
    },

    TSImportEqualsDeclaration(p) {
      const ref = p.node.moduleReference;
      if (ref.type !== 'TSExternalModuleReference') return;
      const { line, col } = pos(p.node);
      const local = p.node.id.name;
      const isType = p.node.importKind === 'type';
      const idx = addImport({
        specifier: ref.expression.value,
        kind: isType ? 'type-only' : 'require',
        bindings: [{ local, imported: 'default', isType }],
        line,
        col,
        snippet: lineText(lines, line, IMPORT_SNIPPET_MAX)
      });
      own(p, idx, local, 'default');
    },

    TSImportType(p) {
      const arg = p.node.argument as t.Node;
      const lit = arg.type === 'StringLiteral' ? arg.value : null;
      if (lit === null) return;
      const { line, col } = pos(p.node);
      addImport({
        specifier: lit,
        kind: 'type-only',
        bindings: [],
        line,
        col,
        snippet: lineText(lines, line, IMPORT_SNIPPET_MAX),
        viaTypeQuery: true
      });
    },

    ExportAllDeclaration(p) {
      const node = p.node;
      const { line, col } = pos(node);
      const idx = addImport({
        specifier: node.source.value,
        kind: node.exportKind === 'type' ? 'type-only' : 'export-from',
        bindings: [],
        line,
        col,
        snippet: lineText(lines, line, IMPORT_SNIPPET_MAX)
      });
      reexports.push({ importIndex: idx, exported: '*', imported: '*' });
    },

    ExportNamedDeclaration(p) {
      const node = p.node;
      if (node.source !== null && node.source !== undefined) {
        const { line, col } = pos(node);
        const allType =
          node.exportKind === 'type' ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((s) => s.type === 'ExportSpecifier' && s.exportKind === 'type'));
        const idx = addImport({
          specifier: node.source.value,
          kind: allType ? 'type-only' : 'export-from',
          bindings: [],
          line,
          col,
          snippet: lineText(lines, line, IMPORT_SNIPPET_MAX)
        });
        for (const s of node.specifiers) {
          if (s.type === 'ExportNamespaceSpecifier') {
            reexports.push({ importIndex: idx, exported: exportedNameOf(s.exported), imported: '*' });
          } else if (s.type === 'ExportDefaultSpecifier') {
            reexports.push({ importIndex: idx, exported: s.exported.name, imported: 'default' });
          } else {
            reexports.push({ importIndex: idx, exported: exportedNameOf(s.exported), imported: s.local.name });
          }
        }
        return;
      }
      const decl = node.declaration;
      if (decl !== null && decl !== undefined) {
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            for (const name of declaredNames(d.id)) exports.push(name);
          }
        } else if ('id' in decl && decl.id !== null && decl.id !== undefined && decl.id.type === 'Identifier') {
          exports.push(decl.id.name);
        }
        return;
      }
      for (const s of node.specifiers) {
        if (s.type !== 'ExportSpecifier') continue;
        pendingExports.push({ local: s.local.name, exported: exportedNameOf(s.exported), binding: p.scope.getBinding(s.local.name) });
      }
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (decl.type === 'Identifier') {
        pendingExports.push({ local: decl.name, exported: 'default', binding: p.scope.getBinding(decl.name) });
      } else {
        exports.push('default');
      }
    },

    TSExportAssignment() {
      exports.push('default');
    },

    AssignmentExpression(p) {
      const left = p.node.left;
      if (left.type !== 'MemberExpression') return;
      const obj = left.object;
      const isModuleExports =
        (obj.type === 'Identifier' && obj.name === 'module' && propName(left) === 'exports') ||
        (obj.type === 'Identifier' && obj.name === 'exports') ||
        (obj.type === 'MemberExpression' &&
          obj.object.type === 'Identifier' &&
          obj.object.name === 'module' &&
          propName(obj) === 'exports');
      if (!isModuleExports || p.scope.getBinding(obj.type === 'Identifier' ? obj.name : 'module') !== undefined) return;
      cjsExports = true;
      // module.exports = … → 'default' (+ the keys of an object literal); exports.x / module.exports.x → 'x'.
      if (obj.type === 'Identifier' && obj.name === 'module') {
        exports.push('default');
        const right = p.node.right;
        if (right.type === 'ObjectExpression') {
          for (const prop of right.properties) {
            if ((prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') && !prop.computed && prop.key.type === 'Identifier') {
              exports.push(prop.key.name);
            }
          }
        }
      } else {
        const name = propName(left);
        if (name !== null) exports.push(name);
      }
    },

    CallExpression(p) {
      const node = p.node;
      const callee = node.callee;
      const isRequire = callee.type === 'Identifier' && callee.name === 'require';
      const isImport = callee.type === 'Import';
      if (!isRequire && !isImport) return;
      const arg = node.arguments[0] as t.Node | undefined;
      const { line, col } = pos(node);
      const lit = literalSpecifier(arg);
      if (lit === null) {
        addImport({ specifier: null, kind: 'dynamic-expr', bindings: [], line, col, snippet: lineText(lines, line, IMPORT_SNIPPET_MAX) });
        return;
      }
      const kind: EdgeKind = isImport || lit.template ? 'dynamic-literal' : 'require';
      const bindings: ParsedBinding[] = [];
      const parent = p.parentPath;
      if (kind === 'require' && parent?.node.type === 'VariableDeclarator' && parent.node.init === node) {
        const id = parent.node.id;
        if (id.type === 'Identifier') {
          bindings.push({ local: id.name, imported: 'default', isType: false });
        } else if (id.type === 'ObjectPattern') {
          for (const prop of id.properties) {
            if (prop.type !== 'ObjectProperty' || prop.computed) continue;
            const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : null;
            const value = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (key !== null && value.type === 'Identifier') bindings.push({ local: value.name, imported: key, isType: false });
          }
        }
      }
      const idx = addImport({
        specifier: lit.value,
        kind: kind === 'require' && bindings.length === 0 && parent?.node.type === 'ExpressionStatement' ? 'side-effect' : kind,
        bindings,
        line,
        col,
        snippet: lineText(lines, line, IMPORT_SNIPPET_MAX)
      });
      if (parent !== null) for (const b of bindings) own(parent, idx, b.local, b.imported);
    }
  };

  try {
    traverse(ast, visitor);
  } catch (err) {
    return emptyResult(`traverse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const pe of pendingExports) {
    const owner = pe.binding === undefined ? undefined : bindingOwners.get(pe.binding);
    if (owner !== undefined) reexports.push({ importIndex: owner.importIndex, exported: pe.exported, imported: owner.imported });
    else exports.push(pe.exported);
  }

  const usages: ParsedUsage[] = [];
  for (const [binding, owner] of bindingOwners) {
    for (const ref of binding.referencePaths) {
      const u = classifyReference(ref);
      if (u === null) continue;
      const line = ref.node.loc?.start.line ?? 0;
      usages.push({
        importIndex: owner.importIndex,
        local: owner.local,
        imported: owner.imported,
        member: u.member,
        kind: u.kind,
        line,
        col: ref.node.loc?.start.column ?? 0,
        snippet: lineText(lines, line, USAGE_SNIPPET_MAX)
      });
    }
  }
  usages.sort((a, b) => a.line - b.line || a.col - b.col || a.local.localeCompare(b.local));

  const recoverable = (ast as { errors?: Array<{ message?: string }> }).errors ?? [];
  return {
    imports,
    exports: [...new Set(exports)],
    reexports,
    usages,
    hasExports: exports.length > 0 || reexports.length > 0 || cjsExports,
    // errorRecovery: keep what was extracted (v1 parity) but record the first error.
    parseError: recoverable.length > 0 ? String(recoverable[0]?.message ?? 'parse error') : null
  };
}

/** Names bound by a declarator id (identifier or destructuring pattern). */
function declaredNames(id: t.LVal): string[] {
  const out: string[] = [];
  const stack: t.Node[] = [id];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'Identifier') out.push(n.name);
    else if (n.type === 'ObjectPattern') for (const prop of n.properties) stack.push(prop.type === 'RestElement' ? prop.argument : prop.value);
    else if (n.type === 'ArrayPattern') {
      for (const el of n.elements) if (el !== null) stack.push(el);
    }
    else if (n.type === 'AssignmentPattern') stack.push(n.left);
    else if (n.type === 'RestElement') stack.push(n.argument);
  }
  return out.reverse();
}

function propName(m: t.MemberExpression | t.OptionalMemberExpression): string | null {
  if (!m.computed && m.property.type === 'Identifier') return m.property.name;
  if (m.property.type === 'StringLiteral') return m.property.value;
  return null;
}

function classifyReference(ref: NodePath): { kind: UsageKind; member: string | null } | null {
  const node = ref.node;
  const parent = ref.parentPath;
  if (parent === null) return { kind: 'value', member: null };
  const pn = parent.node;
  // `export { x }` / `export default x` is a re-export, not a use.
  if (pn.type === 'ExportSpecifier' || pn.type === 'ExportDefaultDeclaration') return null;

  if (node.type === 'JSXIdentifier') {
    if (pn.type === 'JSXMemberExpression' && pn.object === node) return { kind: 'jsx', member: pn.property.name };
    return { kind: 'jsx', member: null };
  }

  if ((pn.type === 'MemberExpression' || pn.type === 'OptionalMemberExpression') && pn.object === node) {
    const member = propName(pn);
    const gp = parent.parentPath?.node;
    if (gp !== undefined && (gp.type === 'CallExpression' || gp.type === 'OptionalCallExpression') && gp.callee === pn) {
      return { kind: 'call', member };
    }
    if (gp !== undefined && gp.type === 'NewExpression' && gp.callee === pn) return { kind: 'new', member };
    return { kind: 'member', member };
  }
  if ((pn.type === 'CallExpression' || pn.type === 'OptionalCallExpression') && pn.callee === node) {
    return { kind: 'call', member: null };
  }
  if (pn.type === 'NewExpression' && pn.callee === node) return { kind: 'new', member: null };
  return { kind: 'value', member: null };
}

/**
 * Parse with the same options as the adapter and return the raw AST (or null
 * on a fatal error). Used to read config files as data (aliases, config refs).
 */
export function parseAst(source: string): t.File | null {
  try {
    return babel.parse(source, BABEL_OPTIONS) as unknown as t.File;
  } catch {
    return null;
  }
}

/** Babel traverse, shared with the config readers so they need no second require. */
export function traverseAst(ast: t.File, visitor: TraverseOptions): void {
  traverse(ast, visitor);
}

export const babelParser: ParserAdapter = Object.freeze({
  id: `babel@${BABEL_PARSER_VERSION}`,
  parse: parseBabel
});

// ------------------------------------------------------------------ roles

const JS_EXT = String.raw`\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$`;
const APP_ROLE_RE = new RegExp(String.raw`(?:^|/)app/(?:.*/)?(page|layout|route|template|loading|error|not-found|default)` + JS_EXT);
const PROJECT_PREFIX = String.raw`^(?:(?:apps|packages)/[^/]+/)?(?:src/)?`;
const PAGES_RE = new RegExp(PROJECT_PREFIX + String.raw`pages/(.+)` + JS_EXT);
const MIDDLEWARE_RE = new RegExp(PROJECT_PREFIX + 'middleware' + JS_EXT);

/**
 * Framework role from the path alone (+ package.json entry targets, already
 * resolved to project-relative POSIX paths by the caller).
 */
export function fileRole(relPosixPath: string, entryPaths: readonly string[]): FileRole | null {
  const app = APP_ROLE_RE.exec(relPosixPath);
  if (app?.[1] !== undefined) return app[1] as FileRole;
  const pages = PAGES_RE.exec(relPosixPath);
  if (pages?.[1] !== undefined) return pages[1].startsWith('api/') || pages[1] === 'api' ? 'api-route' : 'page';
  if (MIDDLEWARE_RE.test(relPosixPath)) return 'middleware';
  if (entryPaths.includes(path.posix.normalize(relPosixPath))) return 'entry';
  return null;
}
