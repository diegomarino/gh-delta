// Project-wide static analysis policy for Node ESM source and tests.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';

const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  URL: 'readonly',
};

export default defineConfig([
  {
    ignores: ['.npm-cache/**', 'coverage/**', 'node_modules/**', 'state/**', '*.tgz'],
  },
  js.configs.recommended,
  {
    name: 'gh-delta/node-esm',
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]);
