/**
 * Known config files (V2_STAGE3_SPEC 3a.5/3a.6, D3). Pure name matching.
 *
 * - Data configs (JSON/YAML/rc) are walked as `kind: 'config'` and read as
 *   data, never executed.
 * - JS/TS configs are ordinary `kind: 'js'` files (normal import edges) that
 *   also get `config-ref` edges from their string literals.
 */
import path from 'path';

export type ConfigTool =
  | 'babel'
  | 'postcss'
  | 'tailwind'
  | 'eslint'
  | 'prettier'
  | 'webpack'
  | 'vite'
  | 'next'
  | 'jest'
  | 'vitest'
  | 'craco'
  | 'tsconfig'
  | 'package';

export type ConfigFormat = 'json' | 'yaml' | 'js';

export interface ConfigFileInfo {
  tool: ConfigTool;
  format: ConfigFormat;
}

const DATA_CONFIGS: Readonly<Record<string, ConfigFileInfo>> = Object.freeze({
  'package.json': { tool: 'package', format: 'json' },
  'tsconfig.json': { tool: 'tsconfig', format: 'json' },
  'jsconfig.json': { tool: 'tsconfig', format: 'json' },
  '.babelrc': { tool: 'babel', format: 'json' },
  '.babelrc.json': { tool: 'babel', format: 'json' },
  'babel.config.json': { tool: 'babel', format: 'json' },
  '.eslintrc': { tool: 'eslint', format: 'json' },
  '.eslintrc.json': { tool: 'eslint', format: 'json' },
  '.eslintrc.yml': { tool: 'eslint', format: 'yaml' },
  '.eslintrc.yaml': { tool: 'eslint', format: 'yaml' },
  '.prettierrc': { tool: 'prettier', format: 'json' },
  '.prettierrc.json': { tool: 'prettier', format: 'json' },
  '.prettierrc.yml': { tool: 'prettier', format: 'yaml' },
  '.prettierrc.yaml': { tool: 'prettier', format: 'yaml' },
  '.postcssrc': { tool: 'postcss', format: 'json' },
  '.postcssrc.json': { tool: 'postcss', format: 'json' },
  '.postcssrc.yml': { tool: 'postcss', format: 'yaml' },
  '.postcssrc.yaml': { tool: 'postcss', format: 'yaml' },
  'jest.config.json': { tool: 'jest', format: 'json' }
});

const JS_CONFIG_RE =
  /^(babel|postcss|tailwind|eslint|prettier|webpack|vite|next|jest|vitest|craco)(?:\.[\w-]+)?\.config\.(?:js|cjs|mjs|ts|cts|mts)$/;
const JS_RC_RE = /^\.(babelrc|eslintrc|prettierrc|postcssrc)\.(?:js|cjs|mjs)$/;
const TSCONFIG_VARIANT_RE = /^tsconfig\.[\w.-]+\.json$/;

const RC_TOOL: Readonly<Record<string, ConfigTool>> = Object.freeze({
  babelrc: 'babel',
  eslintrc: 'eslint',
  prettierrc: 'prettier',
  postcssrc: 'postcss'
});

/** Data config (JSON/YAML) recognised by basename, or null. */
export function dataConfigInfo(relPosixPath: string): ConfigFileInfo | null {
  const base = path.posix.basename(relPosixPath);
  const known = DATA_CONFIGS[base];
  if (known !== undefined) return known;
  if (TSCONFIG_VARIANT_RE.test(base)) return { tool: 'tsconfig', format: 'json' };
  return null;
}

/** JS/TS config file recognised by basename, or null. */
export function jsConfigInfo(relPosixPath: string): ConfigFileInfo | null {
  const base = path.posix.basename(relPosixPath);
  const m = JS_CONFIG_RE.exec(base);
  if (m?.[1] !== undefined) return { tool: m[1] as ConfigTool, format: 'js' };
  const rc = JS_RC_RE.exec(base);
  if (rc?.[1] !== undefined) {
    const tool = RC_TOOL[rc[1]];
    if (tool !== undefined) return { tool, format: 'js' };
  }
  return null;
}

export function configInfo(relPosixPath: string): ConfigFileInfo | null {
  return dataConfigInfo(relPosixPath) ?? jsConfigInfo(relPosixPath);
}
