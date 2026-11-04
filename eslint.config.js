// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import importPlugin from 'eslint-plugin-import'
import noRelativeImportPaths from 'eslint-plugin-no-relative-import-paths'
import boundaries from 'eslint-plugin-boundaries'
import tailwindcss from 'eslint-plugin-tailwindcss'
import i18next from 'eslint-plugin-i18next'
import { uiDriftSelectors } from './eslint-rules/no-ui-drift.js'
import { rawMoneyFormatSelectors } from './eslint-rules/no-raw-money-format.js'
import path from 'node:path'

export default tseslint.config({
  ignores: [
    'node_modules',
    'dist',
    'build',
    'target',
    'src-tauri',
    '*.config.ts',
    '*.config.js',
    'vite-env.d.ts',
    'src/shared/lib/supabase.types.ts',
  ],
}, js.configs.recommended, ...tseslint.configs.strictTypeChecked, {
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
}, {
  files: ['**/*.{ts,tsx}'],
  plugins: {
    react,
    'react-hooks': reactHooks,
    'react-refresh': reactRefresh,
    'jsx-a11y': jsxA11y,
    import: importPlugin,
    'no-relative-import-paths': noRelativeImportPaths,
    boundaries,
    // Registered here too (not just the scoped i18next block below) so
    // eslint-disable comments for `i18next/no-literal-string` in files
    // outside the 5-layer scope (e.g. src/shared/lib, src/app) resolve as
    // known-but-inactive instead of "Definition for rule ... was not found".
    i18next,
  },
  linterOptions: {
    // A disable comment for `i18next/no-literal-string` is legitimately
    // "unused" for files matched by this object but not by the scoped
    // i18next block below (the rule isn't enabled here).
    reportUnusedDisableDirectives: 'off',
  },
  settings: {
    react: {
      version: 'detect',
    },
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: ['./tsconfig.json', './tsconfig.node.json'],
      },
    },
    'boundaries/elements': [
      { type: 'app', pattern: 'src/app/**' },
      { type: 'pages', pattern: 'src/pages/**' },
      { type: 'widgets', pattern: 'src/widgets/**' },
      { type: 'features', pattern: 'src/features/**' },
      { type: 'entities', pattern: 'src/entities/**' },
      { type: 'shared', pattern: 'src/shared/**' },
    ],
  },
  rules: {
    ...react.configs.recommended.rules,
    ...reactHooks.configs.recommended.rules,
    ...jsxA11y.configs.recommended.rules,
    'react/react-in-jsx-scope': 'off',
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'import/no-cycle': 'error',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        pathGroups: [
          { pattern: '@app/**', group: 'internal', position: 'before' },
          { pattern: '@pages/**', group: 'internal', position: 'before' },
          { pattern: '@widgets/**', group: 'internal', position: 'before' },
          { pattern: '@features/**', group: 'internal', position: 'before' },
          { pattern: '@entities/**', group: 'internal', position: 'before' },
          { pattern: '@shared/**', group: 'internal', position: 'before' },
        ],
        pathGroupsExcludedImportTypes: ['builtin'],
        alphabetize: { order: 'asc' },
      },
    ],
    'no-relative-import-paths/no-relative-import-paths': [
      'off',
    ],
    'boundaries/dependencies': [
      'error',
      {
        default: 'disallow',
        rules: [
          {
            from: ['app'],
            allow: ['pages', 'widgets', 'features', 'entities', 'shared'],
          },
          {
            from: ['pages'],
            allow: ['widgets', 'features', 'entities', 'shared'],
          },
          {
            from: ['widgets'],
            allow: ['features', 'entities', 'shared'],
          },
          {
            from: ['features'],
            allow: ['entities', 'shared'],
          },
          {
            from: ['entities'],
            allow: ['shared'],
          },
          {
            from: ['shared'],
            allow: [],
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ExportAllDeclaration',
        message: 'Barrel exports (export *) are banned. Export only what you explicitly need.',
      },
      // The browser never holds an OpenAI (or any LLM provider) key
      // directly — every model call goes through agent-proxy. This selector
      // only reaches this base block's file set (src/pages|widgets|features
      // replace, not merge, no-restricted-syntax for their own files — see
      // the REPLACE gotcha documented below — but no-restricted-imports
      // below is a different rule key and reaches everywhere regardless).
      {
        selector: 'Property[key.name="dangerouslyAllowBrowser"]',
        message:
          'dangerouslyAllowBrowser puts a client-side LLM provider key in the browser bundle — the browser never holds a provider key; route the call through agent-proxy instead.',
      },
      ...rawMoneyFormatSelectors,
    ],
    // No client code imports an LLM provider SDK directly — the browser
    // never holds a provider key. Every model call already goes through
    // agent-proxy (src/shared/lib/edge-function-contracts.ts).
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'openai',
            message: 'The browser never holds an OpenAI key — route model calls through agent-proxy instead.',
          },
        ],
        patterns: ['openai/*'],
      },
    ],
  },
},
{
  // LINT-01 (D-13/D-14): drift-detection guardrails scoped to the Phase-29
  // audited zone (src/pages|widgets|features), excluding src/shared/ui (D-12,
  // the primitive-definition layer legitimately uses raw elements internally)
  // and src/entities (never audited by Phase 29). Test/stories files are
  // ignored — they carry raw elements in mock components (matches Phase 29's
  // own scan exclusions).
  files: ['src/pages/**/*.tsx', 'src/widgets/**/*.tsx', 'src/features/**/*.tsx'],
  ignores: ['**/*.test.tsx', '**/*.stories.tsx'],
  plugins: { tailwindcss },
  settings: {
    tailwindcss: {
      // eslint-plugin-tailwindcss@4 requires cssConfigPath to point at the
      // Tailwind v4 CSS entry point (must be a .css file), not the old v3
      // JS/TS config — tailwind.config.ts is no longer read by Tailwind
      // itself post-v4-upgrade (all theme values live in globals.css's
      // @theme block). Must be an absolute path for the same require.resolve
      // reliability reason the old `config` path was absolute.
      cssConfigPath: path.resolve(import.meta.dirname, 'src/app/globals.css'),
      functions: ['cn', 'clsx', 'classnames', 'ctl', 'cva', 'tv'],
    },
  },
  rules: {
    'tailwindcss/no-custom-classname': [
      'error',
      { whitelist: ['^(animate|fade|slide|zoom)-(in|out)(-from-\\w+)?$'] },
    ],
    'tailwindcss/enforces-shorthand': 'error',
    // tailwindcss/no-arbitrary-value intentionally NOT enabled — D-15.
    // It flags any bracketed value (h-[...], w-[...], min-h-[...], etc.), not
    // just spacing, which would newly flag ~70 pre-existing, non-drift,
    // legitimate arbitrary-size classes outside this phase's scope.
    // Arbitrary-value SPACING drift specifically is covered by the narrow
    // custom selector in uiDriftSelectors below instead.

    // Restate ExportAllDeclaration verbatim: flat config REPLACES (does not
    // merge) a rule key across config objects matching the same file. This
    // later, more-specific object fully overrides no-restricted-syntax for
    // pages/widgets/features files — omitting the barrel-export selector
    // here would silently kill that ban for those files.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ExportAllDeclaration',
        message: 'Barrel exports (export *) are banned. Export only what you explicitly need.',
      },
      ...uiDriftSelectors,
      ...rawMoneyFormatSelectors,
    ],
  },
},
{
  // D-08/D-09: money-selector exemptions. Later and narrower than the base
  // block and the pages/widgets/features block above, so per the REPLACE
  // (not merge) gotcha documented on the tailwindcss block, this object's
  // no-restricted-syntax fully overrides theirs for exactly this file set —
  // restating only the barrel-export selector, with no UI-drift or money
  // selectors. src/shared/lib/format.ts is exempt because it cannot be
  // written without the raw constructs it bans; test/story/mocks/e2e-spec
  // files are exempt because they legitimately assert on or construct raw
  // money strings as fixtures, not production display code. Deliberately
  // NOT exempt: src/shared/lib/receipt-format.ts and
  // src/shared/lib/exporters/pdf.tsx (verified against real content in
  // plan 08 — both had genuine hand-built currency strings, migrated in
  // plan 02).
  files: [
    'src/shared/lib/format.ts',
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.stories.tsx',
    '**/mocks.ts',
    'e2e/**/*.spec.ts',
  ],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ExportAllDeclaration',
        message: 'Barrel exports (export *) are banned. Export only what you explicitly need.',
      },
    ],
  },
},
{
  files: ['**/*.test.ts', '**/*.test.tsx', '**/*.stories.tsx', '**/mocks.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
    'boundaries/dependencies': 'off',
  }
},
{
  // 21-12: committed, strict, no-grandfather i18next/no-literal-string
  // enforcement (D-05) — folded in from the now-deleted standalone
  // eslint.i18n.config.js once every scoped layer's sweep (21-06..21-11)
  // reported string-clean. Mirrors the tailwindcss block's file-scoping
  // shape above. Deliberately does NOT set `no-restricted-syntax` (see the
  // REPLACE gotcha comment on the tailwindcss block) so the barrel-export
  // ban restated there for pages/widgets/features is not silently wiped for
  // files also matched here.
  files: [
    'src/shared/ui/**/*.tsx',
    'src/entities/**/*.{ts,tsx}',
    'src/features/**/*.{ts,tsx}',
    'src/widgets/**/*.{ts,tsx}',
    'src/pages/**/*.tsx',
  ],
  ignores: ['**/*.test.tsx', '**/*.test.ts', '**/*.stories.tsx', '**/mocks.ts'],
  plugins: { i18next },
  rules: {
    'i18next/no-literal-string': ['error', {
      mode: 'all', // catches JSX text, JSX attributes, AND call arguments (Pitfall 5)
      'jsx-attributes': {
        exclude: [
          'data-testid', 'className', 'to', 'type', 'key', 'role', 'variant',
          'size', 'name', 'htmlFor', 'id', 'value', 'defaultValue', 'aria-hidden',
          'data-slot', 'aria-invalid',
          'aria-describedby',
          'aria-labelledby',
          'step',
          'accept',
          'height',
          'confirmClassName',
          'highlight',
          'stackId',
          'backTo',
        ],
      },
      callees: {
        exclude: [
          'cn', 'clsx', 'classnames', 'ctl', 'cva', 'tv', 't', 'can', 'canAccess', 'logger\\.\\w+',
          'rpc', 'navigate', 'from', 'select', 'eq', 'order', 'insert', 'update', 'delete',
          'executeTool', 'logHardwareFail', 'toLocaleDateString', 'toLocaleTimeString',
          'toLocaleString', 'usePersistedBool',
          'neq', 'gte', 'lte', 'not', 'in', 'is', 'single', 'channel', 'on',
          'get',
        ],
      },
      'object-properties': {
        exclude: [
          'key', 'id', 'accessorKey', 'displayName', 'className', 'aria-invalid', 'labelKey',
          'status', 'maxHeight', 'event', 'schema', 'table', 'count', 'onConflict',
        ],
      },
      words: {
        exclude: [
          '^[0-9.,$%:@#/x×+*-]+$', '^[A-Z_]{2,}$', '^—$', '^[●○−–]+$', '^[↑↓]+$',
          '^#[0-9a-fA-F]{3,8}$',
        ],
      },
    }],
  },
}, storybook.configs["flat/recommended"]);
