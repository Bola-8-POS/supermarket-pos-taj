import type { Config } from 'tailwindcss'

// NOTE (Tailwind v4 upgrade): Tailwind itself no longer reads this file —
// all theme values now live in the `@theme` block in `src/app/globals.css`,
// which is the source of truth. This file is kept only because
// `scripts/generate-design-tokens.ts` still imports it directly to read
// color/radius values programmatically. Keep the two in sync manually until
// that script is migrated to read `globals.css`'s `@theme` block instead.
const config: Config = {
  // 'media' — dark mode follows system preference (prefers-color-scheme: dark)
  // Switch to ['class'] later if a manual toggle is needed
  darkMode: 'media',
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      colors: {
        // shadcn/ui v4 uses complete oklch() values in CSS vars.
        // Use var(--x) directly — do NOT wrap in hsl() since the value is already a full color.
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        // POS-specific semantic colors
        'pos-accent': 'var(--pos-accent)',
        'pos-danger': 'var(--pos-danger)',
        'pos-warning': 'var(--pos-warning)',
        'pos-highlight': 'var(--pos-highlight)',
      },
      keyframes: {
        'caret-blink': {
          '0%,70%,100%': { opacity: '1' },
          '20%,50%': { opacity: '0' },
        },
      },
      animation: {
        'caret-blink': 'caret-blink 1.25s ease-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
