module.exports = {
  // Limit ESLint to app source; root configs / .storybook / supabase functions use other tsconfigs.
  // --no-warn-ignored suppresses "file ignored because of ignore pattern" warning for supabase.types.ts
  'src/**/*.{ts,tsx}': ['eslint --fix --max-warnings 0 --no-warn-ignored', 'prettier --write'],
  '*.{json,md,css}': ['prettier --write'],
};
