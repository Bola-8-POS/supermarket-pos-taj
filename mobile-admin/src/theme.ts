/**
 * Design tokens — lifted from the desktop POS "Counter" dark theme
 * (src/app/globals.css, prefers-color-scheme: dark block), converted oklch → hex.
 * Dark only (R6 in the spec).
 */
export const colors = {
  background: '#0a0c11',
  surface: '#0f1216',
  card: '#13161b',
  popover: '#171a1e',
  surfaceRaised: '#1a1d22',
  muted: '#1e2125',
  secondary: '#212429',
  accent: '#23272c',
  border: 'rgba(255,255,255,0.09)',
  borderStrong: 'rgba(255,255,255,0.16)',
  input: 'rgba(255,255,255,0.14)',

  foreground: '#eceff2',
  mutedForeground: '#9399a0',
  sidebarMuted: '#8a9097',

  brand: '#47c7c7',
  brandForeground: '#001315',
  brandStrong: '#82e1e0',
  brandSoft: 'rgba(71,199,199,0.14)',

  success: '#57c173',
  successForeground: '#021406',
  successSoft: 'rgba(87,193,115,0.14)',

  warning: '#f7b83d',
  warningForeground: '#241100',
  warningSoft: 'rgba(247,184,61,0.14)',

  destructive: '#f05653',
  destructiveForeground: '#fffafa',
  destructiveSoft: 'rgba(240,86,83,0.14)',
} as const;

export const radius = { xs: 6, sm: 8, md: 10, lg: 12, xl: 16 } as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const type = {
  display: { fontSize: 32, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.5 },
  h1: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.3 },
  h2: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.6 },
  mono: { fontFamily: 'monospace' as const },
} as const;

export const touch = { min: 44, comfy: 56 } as const;
