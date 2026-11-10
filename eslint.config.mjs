// ESLint 9 flat config (v2 Stage 1.6, updated Stage 2.5).
//
// Why ESLint 9 and not 10 (D14): eslint-plugin-react (7.37.5) and
// eslint-plugin-jsx-a11y (6.10.2) — both part of the `next/core-web-vitals`
// rule set — still declare peers up to ESLint 9 only (re-checked 2026-11-10),
// so ESLint 10 would need --legacy-peer-deps.
//
// Why no eslint-config-next (proposed D17): eslint-config-next@16 pulls
// eslint-plugin-react-hooks ^7, whose `recommended` preset turns on the React
// Compiler rules (purity, refs, set-state-in-effect, ...) as errors. Adopting
// them is a separate code-quality task, so this file keeps composing the
// `next/core-web-vitals` preset by hand from the same plugins
// (eslint-config-next index.js + core-web-vitals.js):
// react/recommended + react-hooks 5 recommended-latest + @next/next
// recommended and core-web-vitals, plus its rule overrides, the TS parser for
// .ts/.tsx, and the repo's one override (react/no-unescaped-entities: off).
//
// @next/eslint-plugin-next@16 is flat-config native and ESLint 9 compatible, so
// it is registered directly (the Stage 1 @eslint/compat shim is gone).
//
// D1/D23 (Stage 3a.0): `src/core/**` may not import Next.js, React or app/UI
// code, and uses relative imports only: `npm run eval` runs under vite-node,
// which does not read the `@/` alias from vitest.config.ts. Guarded by
// tests/backend/core-boundary.test.ts.
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';
import tsParser from '@typescript-eslint/parser';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'library/**',
      'test-fixtures/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'tsconfig.tsbuildinfo',
      'next-env.d.ts'
    ]
  },
  {
    // ESLint 8 did not report unused disable directives; the existing
    // `// eslint-disable-next-line no-var` comments on `declare global` blocks
    // name a rule this preset does not enable, so keep the old behaviour.
    linterOptions: { reportUnusedDisableDirectives: 'off' }
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      '@next/next': nextPlugin,
      'jsx-a11y': jsxA11yPlugin,
      import: importPlugin
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs['recommended-latest'].rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // eslint-config-next overrides (unchanged from 14.2.35 to 16.4.6):
      'import/no-anonymous-default-export': 'warn',
      'react/no-unknown-property': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'jsx-a11y/alt-text': ['warn', { elements: ['img'], img: ['Image'] }],
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'react/jsx-no-target-blank': 'off',
      // Repo override (was .eslintrc.json):
      'react/no-unescaped-entities': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tsParser }
  },
  {
    files: ['src/core/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'src/core must not import Next.js (D1)' },
            { name: 'react', message: 'src/core must not import React (D1)' },
            { name: 'react-dom', message: 'src/core must not import React (D1)' }
          ],
          patterns: [
            { group: ['next/*'], message: 'src/core must not import Next.js (D1)' },
            { group: ['react/*', 'react-dom/*'], message: 'src/core must not import React (D1)' },
            {
              group: ['@/app/*', '@/components/*', '@/lib/client/*'],
              message: 'src/core must not import app/UI code (D1)'
            },
            {
              group: ['@/*'],
              message: 'src/core uses relative imports — eval runs under vite-node without the @/ alias (D1/D23)'
            }
          ]
        }
      ]
    }
  },
  // V2 Stage 4b: the MCP server (src/mcp) is a thin adapter over core that
  // `npm run mcp` runs under vite-node, so the same rules apply: no Next/React,
  // no app/UI/http code, relative imports only. tests/backend/mcp/adapter.test.ts
  // checks the same thing.
  {
    files: ['src/mcp/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'src/mcp must not import Next.js' },
            { name: 'react', message: 'src/mcp must not import React' },
            { name: 'react-dom', message: 'src/mcp must not import React' }
          ],
          patterns: [
            { group: ['next/*'], message: 'src/mcp must not import Next.js' },
            { group: ['react/*', 'react-dom/*'], message: 'src/mcp must not import React' },
            {
              group: ['../app/*', '../components/*', '../lib/client/*', '../lib/http/*'],
              message: 'src/mcp must not import app/UI/HTTP-route code'
            },
            { group: ['@/*'], message: 'src/mcp uses relative imports — `npm run mcp` runs under vite-node without the @/ alias' }
          ]
        }
      ]
    }
  }
];

export default config;
