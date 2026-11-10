/**
 * Static bundler-alias reader (V2_STAGE3_SPEC 3a.5). Reads webpack / vite /
 * next / craco configs as DATA with Babel; never `require`s or imports them.
 *
 * Accepted shapes:
 *  - `resolve: { alias: { '<key>': <value>, … } }` (object literal)
 *  - `resolve: { alias: [{ find: '<string>', replacement: <value> }] }` (Vite)
 *  - `X.resolve.alias['<key>'] = <value>` and
 *    `X.resolve.alias = { ...X.resolve.alias, '<key>': <value> }` (next.config webpack())
 * Accepted values: string literal, `path.resolve|join(__dirname, '<lit>', …)`,
 * `path.resolve('<lit>')`, `fileURLToPath(new URL('<lit>', import.meta.url))`.
 * Anything else (regex `find`, variables, other calls) → the key is recorded as
 * unreadable, so edges through it can say `alias-unreadable` instead of
 * guessing.
 */
import path from 'path';
import type * as t from '@babel/types';
import { parseAst, traverseAst } from './parse';

export interface AliasRule {
  /** Key as written (incl. a trailing `$` for exact-match webpack keys). */
  key: string;
  /** Absolute path, or a bare specifier when the value is a package name. */
  target: string;
}

export interface UnreadableAlias {
  /** Key as written, or `/source/flags` for a regex `find`. */
  key: string;
  /** For regex keys: a matcher; for string keys: prefix match like a readable alias. */
  regex: RegExp | null;
}

export interface AliasSet {
  /** Directory of the config file (absolute). */
  dir: string;
  rules: AliasRule[];
  unreadable: UnreadableAlias[];
}

function keyOf(node: t.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function stringValue(node: t.Node): string | null {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function calleeName(callee: t.Node): string | null {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const obj = callee.object.type === 'Identifier' ? callee.object.name : null;
    return obj === null ? null : `${obj}.${callee.property.name}`;
  }
  return null;
}

/** Evaluate an alias value; returns null when it is not one of the accepted static shapes. */
function evalValue(node: t.Node, configDir: string): string | null {
  const lit = stringValue(node);
  if (lit !== null) {
    if (lit.startsWith('.') || path.isAbsolute(lit)) return path.resolve(configDir, lit);
    return lit; // bare package name (e.g. 'preact/compat')
  }
  if (node.type === 'CallExpression') {
    const name = calleeName(node.callee);
    if (name === 'path.resolve' || name === 'path.join' || name === 'resolve' || name === 'join') {
      const parts: string[] = [];
      for (const arg of node.arguments) {
        if (arg.type === 'Identifier' && arg.name === '__dirname') parts.push(configDir);
        else {
          const s = stringValue(arg);
          if (s === null) return null;
          parts.push(s);
        }
      }
      if (parts.length === 0) return null;
      // path.resolve('lit') is relative to the config dir here: bundlers run with cwd = config dir.
      return path.isAbsolute(parts[0]!) ? path.resolve(...parts) : path.resolve(configDir, ...parts);
    }
    if (name === 'fileURLToPath' || name === 'url.fileURLToPath') {
      const arg = node.arguments[0];
      if (arg?.type === 'NewExpression' && arg.callee.type === 'Identifier' && arg.callee.name === 'URL') {
        const rel = arg.arguments[0] === undefined ? null : stringValue(arg.arguments[0]);
        const base = arg.arguments[1];
        const baseIsMeta =
          base?.type === 'MemberExpression' &&
          base.object.type === 'MetaProperty' &&
          base.property.type === 'Identifier' &&
          base.property.name === 'url';
        if (rel !== null && baseIsMeta) return path.resolve(configDir, rel);
      }
    }
  }
  return null;
}

function isResolveAliasMember(node: t.Node): boolean {
  // X.resolve.alias
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'alias' &&
    node.object.type === 'MemberExpression' &&
    !node.object.computed &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'resolve'
  );
}

export function readAliasesFromSource(source: string, configDir: string): AliasSet {
  const set: AliasSet = { dir: configDir, rules: [], unreadable: [] };
  const ast = parseAst(source);
  if (ast === null) return set;

  const addObject = (obj: t.ObjectExpression) => {
    for (const prop of obj.properties) {
      if (prop.type !== 'ObjectProperty') continue; // spreads (…config.resolve.alias) carry no new keys
      const key = prop.computed ? stringValue(prop.key) : keyOf(prop.key);
      if (key === null) continue;
      const target = evalValue(prop.value, configDir);
      if (target === null) set.unreadable.push({ key, regex: null });
      else set.rules.push({ key, target });
    }
  };
  const addArray = (arr: t.ArrayExpression) => {
    for (const el of arr.elements) {
      if (el?.type !== 'ObjectExpression') continue;
      let find: t.Node | null = null;
      let replacement: t.Node | null = null;
      for (const prop of el.properties) {
        if (prop.type !== 'ObjectProperty') continue;
        const k = keyOf(prop.key);
        if (k === 'find') find = prop.value;
        if (k === 'replacement') replacement = prop.value;
      }
      if (find === null) continue;
      if (find.type === 'RegExpLiteral') {
        set.unreadable.push({ key: `/${find.pattern}/${find.flags}`, regex: safeRegex(find.pattern, find.flags) });
        continue;
      }
      const key = stringValue(find);
      if (key === null) continue;
      const target = replacement === null ? null : evalValue(replacement, configDir);
      if (target === null) set.unreadable.push({ key, regex: null });
      else set.rules.push({ key, target });
    }
  };

  try {
    traverseAst(ast, {
      ObjectProperty(p) {
        if (keyOf(p.node.key) !== 'alias') return;
        const parentProp = p.parentPath.parentPath;
        if (parentProp?.node.type !== 'ObjectProperty' || keyOf(parentProp.node.key) !== 'resolve') return;
        const v = p.node.value;
        if (v.type === 'ObjectExpression') addObject(v);
        else if (v.type === 'ArrayExpression') addArray(v);
      },
      AssignmentExpression(p) {
        const left = p.node.left;
        if (left.type !== 'MemberExpression') return;
        if (isResolveAliasMember(left)) {
          if (p.node.right.type === 'ObjectExpression') addObject(p.node.right);
          return;
        }
        if (isResolveAliasMember(left.object)) {
          const key = left.computed ? stringValue(left.property) : keyOf(left.property);
          if (key === null) return;
          const target = evalValue(p.node.right, configDir);
          if (target === null) set.unreadable.push({ key, regex: null });
          else set.rules.push({ key, target });
        }
      }
    });
  } catch {
    // A traverse failure leaves whatever was collected; aliases are best effort.
  }
  return set;
}

function safeRegex(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Longest matching readable rule (webpack semantics: `key$` = exact, else exact or `key/…`). */
export function matchAlias(rules: readonly AliasRule[], specifier: string): { rule: AliasRule; rewritten: string } | null {
  let best: { rule: AliasRule; rewritten: string } | null = null;
  for (const rule of rules) {
    const exact = rule.key.endsWith('$');
    const key = exact ? rule.key.slice(0, -1) : rule.key;
    let rest: string | null = null;
    if (specifier === key) rest = '';
    else if (!exact && specifier.startsWith(`${key}/`)) rest = specifier.slice(key.length);
    if (rest === null) continue;
    if (best !== null && key.length <= best.rule.key.replace(/\$$/, '').length) continue;
    const rewritten = path.isAbsolute(rule.target) ? path.join(rule.target, rest) : `${rule.target}${rest}`;
    best = { rule, rewritten };
  }
  return best;
}

export function matchUnreadable(list: readonly UnreadableAlias[], specifier: string): UnreadableAlias | null {
  for (const u of list) {
    if (u.regex !== null) {
      u.regex.lastIndex = 0; // a `g`/`y` flag would make test() stateful
      if (u.regex.test(specifier)) return u;
      continue;
    }
    const key = u.key.endsWith('$') ? u.key.slice(0, -1) : u.key;
    if (specifier === key || (!u.key.endsWith('$') && specifier.startsWith(`${key}/`))) return u;
  }
  return null;
}
