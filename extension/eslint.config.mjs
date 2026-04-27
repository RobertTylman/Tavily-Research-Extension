import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist', 'node_modules'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      globals: {
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        HeadersInit: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        setTimeout: 'readonly',
        navigator: 'readonly',
        React: 'readonly',
        NodeFilter: 'readonly',
        Text: 'readonly',
        Node: 'readonly',
        HTMLButtonElement: 'readonly',
        MouseEvent: 'readonly',
        HTMLElement: 'readonly',
        SVGSVGElement: 'readonly',
        location: 'readonly',
        HTMLSpanElement: 'readonly',
        HTMLDivElement: 'readonly',
        Range: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': ts,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...ts.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  prettier,
];
