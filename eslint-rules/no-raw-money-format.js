/**
 * no-raw-money-format.js — Standalone ESM module, not a full ESLint rule/plugin.
 *
 * Exports `rawMoneyFormatSelectors`: a plain array of `no-restricted-syntax`
 * selector objects (`{ selector, message }`) that AST-detect D-08's two
 * ad-hoc money-formatting patterns: fixed-point two-decimal calls, and a
 * currency-suffixed template/JSX-text element adjacent to an interpolated
 * fixed-point expression. These are spread into the existing
 * `no-restricted-syntax` array in eslint.config.js — never declared as a
 * standalone rule config.
 *
 * Selectors verified against this repo's installed esquery — see
 * .planning/phases/28-money-formatter-utility/28-PATTERNS.md and
 * 28-RESEARCH.md Code Examples for the verification notes.
 */

export const rawMoneyFormatSelectors = [
  {
    selector: "CallExpression[callee.property.name='toFixed'][arguments.0.value=2]",
    message:
      "Raw .toFixed(2) is banned for money display — use formatMoney() from '@shared/lib/format' instead. If this is a non-money quantity, add an eslint-disable-next-line comment explaining why.",
  },
  {
    selector: 'TemplateElement[value.raw=/\\$$/] ~ TemplateElement',
    message:
      "Raw '$'-prefixed template literal is banned for money display — use formatMoney() from '@shared/lib/format' instead.",
  },
  {
    selector:
      "JSXText[value=/\\$\\s*$/] + JSXExpressionContainer CallExpression[callee.property.name='toFixed'][arguments.0.value=2]",
    message:
      "Raw '$' JSX text adjacent to a formatted number is banned for money display — use <MoneyDisplay> or formatMoney() from '@shared/lib/format' instead.",
  },
];
