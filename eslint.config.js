// ESLint flat config for the whole monorepo. Each workspace runs `eslint .` and ESLint finds this file
// by walking up from the linted file. Besides the usual checks, it enforces the package boundaries
// in docs/ARCHITECTURE.md#components.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Builds a `no-restricted-imports` rule entry from a list of forbidden import patterns. */
function forbidImports(patterns) {
  return ['error', { patterns }];
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      'packages/database/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Finds the nearest tsconfig.json for each file, so type-aware rules work in every workspace.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten `await` on a Redis or Postgres call fails silently. This rule makes it a lint error.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // NestJS modules are classes with only decorators and static factory methods.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    // Plain JS config files are not part of any tsconfig.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // packages/shared runs in the browser (the dashboard's filter tester).
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': forbidImports([
        {
          group: ['node:*'],
          message: 'packages/shared must stay browser-safe: no Node built-ins.',
        },
        {
          group: ['@hdl/core', '@hdl/core/*', '@hdl/database', '@hdl/database/*'],
          message: 'packages/shared may import zod only.',
        },
      ]),
    },
  },
  {
    // The library code of packages/database. The seed script is exempt: see docs/adr/0018-seed-script-imports-core.md
    files: ['packages/database/src/**/*.ts'],
    rules: {
      'no-restricted-imports': forbidImports([
        { group: ['@hdl/core', '@hdl/core/*'], message: 'packages/database must not import core.' },
      ]),
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': forbidImports([
        {
          group: ['@hdl/database', '@hdl/database/*'],
          message: 'packages/core must not import database.',
        },
      ]),
    },
  },
);
