// @ts-check
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'packages/client/public/assets/**',
    ],
  },

  /* ---------------------------------------------------------------- base ---- */
  js.configs.recommended,

  /* -------------------------------------------------------- TypeScript ----- */
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },

  /* -------------------------------------------------- shared (isomorphic) -- */
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.es2023,
      },
    },
  },

  /* ----------------------------------------------------------------- tests -- */
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      // `node:test`'s `test()` returns a promise that ESLint cannot correlate with
      // a test name, so it is explicitly allow-listed here.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: 'test', package: 'node:test' },
            { from: 'package', name: 'it', package: 'node:test' },
            { from: 'package', name: 'describe', package: 'node:test' },
          ],
        },
      ],
    },
  },

  /* --------------------------------------------------------------- server -- */
  {
    files: ['packages/server/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Server code logs through the console on purpose (structured logger arrives later).
      'no-console': 'off',
    },
  },

  /* --------------------------------------------------------------- client -- */
  {
    files: ['packages/client/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },

  /* ------------------------------------------------ plain JS / config files - */
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  /* Prettier last: turns off every stylistic rule that would fight the formatter. */
  eslintConfigPrettier,
);
