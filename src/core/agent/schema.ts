/**
 * Small validator for the agent JSON Schema subset (4a.1). Two jobs:
 * - `checkSchemaDef`: a tool definition uses only the strict subset
 *   (`type: 'object'`, `additionalProperties: false` on every object,
 *   `required` ⊆ properties), so `strict: true` on the API side holds.
 * - `validateInput`: the model's tool input matches the schema (types, enum,
 *   required, unknown keys, array items, numeric/length bounds).
 *
 * Messages are stable text (tests and the model rely on them) and never
 * include the offending value, so nothing from the input is echoed back.
 */
import type { AgentSchemaObject, AgentSchemaProperty } from './types';

/** Returns null when the definition is valid, else the first problem. */
export function checkSchemaDef(schema: AgentSchemaObject): string | null {
  if (schema === null || typeof schema !== 'object' || schema.type !== 'object') return 'inputSchema must be { type: "object" }';
  return checkObjectDef(schema, 'input');
}

function checkObjectDef(schema: AgentSchemaObject, at: string): string | null {
  if (schema.additionalProperties !== false) return `${at}: additionalProperties must be false`;
  if (schema.properties === null || typeof schema.properties !== 'object') return `${at}: properties must be an object`;
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return `${at}: required "${key}" is not a property`;
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const problem = checkPropDef(prop, `${at}.${key}`);
    if (problem !== null) return problem;
  }
  return null;
}

function checkPropDef(prop: AgentSchemaProperty, at: string): string | null {
  if (prop === null || typeof prop !== 'object') return `${at}: not a schema`;
  switch (prop.type) {
    case 'object':
      return checkObjectDef(prop, at);
    case 'array':
      return prop.items === undefined ? `${at}: array needs items` : checkPropDef(prop.items, `${at}[]`);
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return null;
    default:
      return `${at}: unsupported type`;
  }
}

/** Returns null when `value` matches, else a stable message naming the path. */
export function validateInput(schema: AgentSchemaObject, value: unknown): string | null {
  return validateObject(schema, value, 'input');
}

function validateObject(schema: AgentSchemaObject, value: unknown, at: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`;
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) return `${at}.${key} is required`;
  }
  for (const key of Object.keys(obj)) {
    const prop = schema.properties[key];
    if (prop === undefined) return `${at}.${key} is not allowed`;
    if (obj[key] === undefined) continue;
    const problem = validateProp(prop, obj[key], `${at}.${key}`);
    if (problem !== null) return problem;
  }
  return null;
}

function validateProp(prop: AgentSchemaProperty, value: unknown, at: string): string | null {
  switch (prop.type) {
    case 'object':
      return validateObject(prop, value, at);
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (prop.maxItems !== undefined && value.length > prop.maxItems) return `${at} must have at most ${prop.maxItems} items`;
      for (let i = 0; i < value.length; i += 1) {
        const problem = validateProp(prop.items, value[i], `${at}[${i}]`);
        if (problem !== null) return problem;
      }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${at} must be a string`;
      if (prop.maxLength !== undefined && value.length > prop.maxLength) return `${at} must be at most ${prop.maxLength} characters`;
      return checkEnum(prop.enum, value, at);
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be a boolean`;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
      if (prop.type === 'integer' && !Number.isInteger(value)) return `${at} must be an integer`;
      if (prop.minimum !== undefined && value < prop.minimum) return `${at} must be >= ${prop.minimum}`;
      if (prop.maximum !== undefined && value > prop.maximum) return `${at} must be <= ${prop.maximum}`;
      return checkEnum(prop.enum, value, at);
    }
    default: {
      const unknown: never = prop;
      return `${at}: unsupported schema ${String(unknown)}`;
    }
  }
}

function checkEnum(allowed: ReadonlyArray<string | number> | undefined, value: string | number, at: string): string | null {
  if (allowed === undefined) return null;
  return allowed.includes(value) ? null : `${at} must be one of: ${allowed.join(', ')}`;
}

/**
 * Copy of the schema without the local-only bounds (`minimum`, `maximum`,
 * `maxItems`, `maxLength`), with the bound folded into the description so the
 * model still sees it. Used for the API tool list only.
 */
export function apiSchemaOf(schema: AgentSchemaObject): Record<string, unknown> {
  return stripObject(schema);
}

function stripObject(schema: AgentSchemaObject): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) properties[key] = stripProp(prop);
  const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (schema.required !== undefined) out.required = [...schema.required];
  if (schema.description !== undefined) out.description = schema.description;
  return out;
}

function stripProp(prop: AgentSchemaProperty): Record<string, unknown> {
  if (prop.type === 'object') return stripObject(prop);
  const bounds: string[] = [];
  const out: Record<string, unknown> = { type: prop.type };
  if (prop.type === 'array') {
    out.items = stripProp(prop.items);
    if (prop.maxItems !== undefined) bounds.push(`at most ${prop.maxItems} items`);
  } else {
    if (prop.enum !== undefined) out.enum = [...prop.enum];
    if (prop.minimum !== undefined) bounds.push(`min ${prop.minimum}`);
    if (prop.maximum !== undefined) bounds.push(`max ${prop.maximum}`);
    if (prop.maxLength !== undefined) bounds.push(`at most ${prop.maxLength} characters`);
  }
  const description = [prop.description, bounds.length > 0 ? `(${bounds.join(', ')})` : undefined].filter((s) => s !== undefined).join(' ');
  if (description !== '') out.description = description;
  return out;
}
