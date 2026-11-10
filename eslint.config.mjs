// ESLint 9 flat config (v2 Stage 1.6).
//
// Why ESLint 9 and not 10: eslint-plugin-react (7.37.5) and eslint-plugin-jsx-a11y
// (6.10.2) — both part of the `next/core-web-vitals` rule set — declare peers up
// to ESLint 9 only (checked 2026-11-09), so ESLint 10 needs --legacy-peer-deps.
// Fallback D14: ESLint 9 now, 10 in Stage 2 with eslint-config-next@16.
//
// Why no eslint-config-next: v14.2.35 ships eslintrc only and peers ESLint ^7 || ^8.
// This file recreates its `next/core-web-vitals` preset by composing the same
// plugins directly (eslint-config-next@14.2.35 index.js + core-web-vitals.js):
// react/recommended + react-hooks/recommended + @next/next recommended and
// core-web-vitals, plus its rule overrides, the TS parser for .ts/.tsx, and the
// repo's one override (react/no-unescaped-entities: off).
//
// Extend here for D1's `src/core` import ban in Stage 3 (no-restricted-imports
// on files: ['src/core/**']).
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';
import tsParser from '@typescript-eslint/parser';
import { fixupPluginRules } from '@eslint/compat';

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
      // @next/eslint-plugin-next@14 calls context.getAncestors() etc., removed in
      // ESLint 9; the official @eslint/compat shim maps them to the new API.
      // Keeps the plugin version matched to Next 14 (drop the shim in Stage 2).
      '@next/next': fixupPluginRules(nextPlugin),
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
      // eslint-config-next@14.2.35 overrides:
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
  }
];

export default config;
