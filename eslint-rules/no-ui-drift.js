/**
 * no-ui-drift.js — Standalone ESM module, not a full ESLint rule/plugin.
 *
 * Exports `uiDriftSelectors`: a plain array of `no-restricted-syntax` selector
 * objects (`{ selector, message }`) that AST-detect the 4 UI-drift categories
 * Phase 29 audited and Phases 30-33/33.1 fixed: raw <button>, raw <input>
 * (with a permanent type-based exemption), hardcoded hex color literals, and
 * rgb()/rgba() color literals, plus the D-15 narrow arbitrary-value spacing
 * selector. These are spread into the existing `no-restricted-syntax` array
 * in eslint.config.js — never declared as a standalone rule config.
 *
 * Regexes for button/input/hex/rgb/spacing are ported 1:1 from
 * scripts/audit-ui-drift.ts's CATEGORY_PATTERNS so this rule catches exactly
 * what that audit script catches, expressed as AST selectors instead of
 * whole-file regex scans.
 */

export const uiDriftSelectors = [
  {
    selector: "JSXOpeningElement[name.name='button']",
    message:
      'Use POSButton or Button from @shared/ui/button instead of a raw <button> element. See DESIGN-TOKENS.md.',
  },
  {
    selector:
      "JSXOpeningElement[name.name='input']:not(:has(JSXAttribute[name.name='type'][value.value=/^(color|time|date|file)$/]))",
    message:
      'Use FormField, MoneyInput, or the correct shared/ui input primitive instead of a raw <input> element. See DESIGN-TOKENS.md. (Native type=color/time/date/file inputs are a documented, permanent exception — 31-CONTEXT.md D-05/D-07.)',
  },
  {
    selector: 'Literal[value=/^#([0-9a-fA-F]{3}){1,2}$/]',
    message:
      'Use a Tailwind CSS-variable token (e.g. bg-primary, text-foreground) instead of a hardcoded color value. See DESIGN-TOKENS.md.',
  },
  {
    selector: 'Literal[value=/rgba?\\(/]',
    message:
      'Use a Tailwind CSS-variable token instead of a hardcoded rgb()/rgba() value. See DESIGN-TOKENS.md.',
  },
  {
    selector:
      "Literal[value=/\\b(?:[a-z:]+:)?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\\[[^\\]]+\\]/]",
    message:
      'Arbitrary-value spacing classes are banned — use a Tailwind spacing scale utility (e.g. p-4, gap-2). See DESIGN-TOKENS.md.',
  },
];
