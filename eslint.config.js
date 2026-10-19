// @ts-check
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One typed-lint engine for the whole workspace (blueprint §23): typescript-eslint with type
 * information from each package's tsconfig. Formatting rules are left to Prettier.
 */
export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/.expo/**',
    // Vendored byte-for-byte from Cutroom (CF-61); integrity is checked by the `integrity` job.
    'packages/backend/src/modules/content/adapters/cutroom/wire-v1/**',
    // Owned and checked elsewhere.
    '.claude/**',
    'ops/**',
    'scripts/**',
    'docs/**',
    'content/**',
  ]),
  js.configs.recommended,
  comments.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.cjs', 'apps/client/*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false },
      ],
      // `any` needs a written reason: an eslint-disable comment with a `--` justification.
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Every database transaction is opened by infrastructure/postgres (withPersonalScope,
    // withTransaction), which marks it so network adapters refuse to run inside (blueprint §19).
    // This catches the direct forms of Kysely's transaction and connection APIs (dot or literal
    // bracket access, destructuring); aliasing through other variables is left to the runtime
    // network guard and review.
    files: ['apps/**/*.ts', 'packages/backend/src/**/*.ts'],
    ignores: ['packages/backend/src/infrastructure/postgres/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          'MemberExpression[property.name=/^(transaction|startTransaction|connection)$/]',
          'MemberExpression[computed=true][property.value=/^(transaction|startTransaction|connection)$/]',
          'ObjectPattern > Property[key.name=/^(transaction|startTransaction|connection)$/]',
          'ObjectPattern > Property[key.value=/^(transaction|startTransaction|connection)$/]',
        ].map((selector) => ({
          selector,
          message:
            'Open transactions and connections through infrastructure/postgres (withPersonalScope or withTransaction) so they are marked.',
        })),
      ],
    },
  },
  {
    // Command-line check scripts report to the terminal.
    files: ['tests/integration/boundaries/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/client/**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.jest } },
  },
  prettier,
);
