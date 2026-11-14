# Design tokens — "Counter" UI system

Source of truth: [`src/app/globals.css`](src/app/globals.css) (`@theme` block +
the light/dark `:root` palettes). Tailwind v4 reads that file directly;
`tailwind.config.ts` is only kept for the token-doc script. ESLint's
`tailwindcss/no-custom-classname` also reads `globals.css`, so a token that is
not declared there fails lint in `pages/`, `widgets/` and `features/`.

## Colour

| Token | Utility | Use for |
|---|---|---|
| `background` / `foreground` | `bg-background`, `text-foreground` | page ground and body text |
| `card` / `card-foreground` | `bg-card` | raised panels, table frames, inputs |
| `popover` | `bg-popover` | dialogs, sheets, menus, selects |
| `muted` / `muted-foreground` | `bg-muted`, `text-muted-foreground` | tinted wells, secondary copy, table header strip |
| `primary` / `primary-foreground` | `bg-primary` | the default filled button ("ink": near-black in light, near-white in dark) |
| `brand` / `brand-foreground` / `brand-soft` / `brand-strong` | `bg-brand`, `text-brand-strong`, `bg-brand-soft` | the single accent: primary CTA (`variant="brand"`), active nav, focus ring, selected states, "top row" highlights |
| `success` / `success-soft` / `success-strong` | `bg-success-soft text-success-strong` | paid / in-stock / discount-applied / online |
| `warning` / `warning-soft` / `warning-strong` | `bg-warning-soft text-warning-strong` | low stock, near-expiry, held sale, offline banner |
| `destructive` / `destructive-soft` | `bg-destructive-soft text-destructive` | errors, refunds, out of stock, delete actions |
| `border` / `border-strong` / `input` / `ring` | `border-border`, `border-input`, `ring-ring` | hairlines, control outlines, focus |
| `sidebar-*` | `bg-sidebar`, `text-sidebar-muted`, `bg-sidebar-accent` | app shell rail only |
| `ink` / `ink-foreground` | `bg-ink` | always-dark slab (login brand panel) — identical in both schemes |
| `pos-accent` / `pos-danger` / `pos-warning` / `pos-highlight` | *(legacy aliases)* | resolve to `success` / `destructive` / `warning` / `brand`; prefer the semantic names in new code |

Never write hex / `rgb()` colours or Tailwind palette colours (`text-amber-950`,
`bg-green-400`) in components — the lint rule blocks the former, and the latter
break dark mode. Soft variants (`*-soft` + `*-strong` text) are for badges,
banners and row highlights; solid variants are for buttons and dots.

## Radius, shadow, motion

- Radius scale: `rounded-md` (8 px) inputs & chips → `rounded-lg` (12 px)
  buttons → `rounded-xl` (16 px) cards/panels → `rounded-2xl` (20 px) dialogs
  and tiles → `rounded-3xl` for hero surfaces. Outer containers are always
  rounder than the controls inside them.
- Shadows are hue-tinted (`--shadow-color-*`): `shadow-xs` on cards/inputs,
  `shadow-md` on hover-lifted tiles, `shadow-lg`/`shadow-xl` on popovers and
  dialogs. Dark mode swaps the tint automatically.
- Motion: `duration-150` for colour/border, `duration-200` + `ease-out-quart`
  for lifts, `animate-fade-up` for page content, `animate-fade-in` for tab
  panels and list rows. `prefers-reduced-motion` strips movement globally.

## Typography

Geist Variable everywhere (`font-sans`; `font-heading` is an alias).
`font-mono` falls back to the platform monospace (IDs, barcodes, receipts).
Money uses `MoneyDisplay` (`text-numeric` = tabular lining figures). Section
eyebrows and table headers use `text-[0.6875rem] font-semibold tracking-[0.12em]
uppercase text-muted-foreground`.

## Component conventions

- Page bodies go through `PageContainer` (sticky title bar + scrolling well;
  `width="fluid"` / `flush` for split-pane screens). Navigation lives in the
  app shell — pages must not render their own "Back home" link.
- Route destinations are declared once in
  [`src/shared/config/navigation.ts`](src/shared/config/navigation.ts); the
  sidebar and the Home tiles both render from it.
- Buttons: `Button`/`POSButton` only. `variant="brand"` is reserved for the one
  primary action on a screen (charge, confirm receipt); `default` for
  secondary-primary actions; `outline`/`ghost` for the rest; `destructive`
  is the soft red that fills on hover.
- Badges: `success` / `warning` / `brand` / `destructive` / `muted` soft
  variants — square-cornered, 24 px tall, one per status.
- Tables: wrap in `overflow-hidden rounded-xl border border-border bg-card
  shadow-xs` (what `DataTable` does); row highlights use `border-l-2` with a
  `*-soft/60` wash.
- Inputs: shadcn `Input`/`Select`/`Textarea`; a native `<select>`/`<input>`
  must copy the same classes (`h-10 rounded-lg border border-input bg-card px-3
  shadow-xs dark:bg-input/20` + the focus ring).
- Grouped settings-style navigation uses `VerticalTabsList`/`VerticalTabsGroupLabel`/
  `VerticalTabsTrigger` inside `<Tabs orientation="vertical">` — never a hand-built
  list of buttons.
