import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'hardware/**', 'firmware/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-based tooling scripts (issue #14 brings tools/** under ESLint; it was
    // previously ignored, leaving the GPL-3.0 licensing guard unlinted). These
    // are plain ES-module Node scripts, not TypeScript, so give them the Node
    // globals they rely on.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      'react/react-in-jsx-scope': 'off',
    },
  },
);
