/**
 * generate-design-tokens.ts — Standalone Node script (not bundled into the app, never imported by src/).
 *
 * Reads the color + border-radius tokens from tailwind.config.ts (structured import) and the
 * light-mode CSS custom-property values from src/app/globals.css (regex-extracted), then writes
 * markdown tables into DESIGN-TOKENS.md, replacing ONLY the content between the
 * <!-- GENERATED:START --> / <!-- GENERATED:END --> markers. All hand-written content outside
 * those markers (Touch Targets, Focus Emphasis, Dark Mode, Do/Don't) is preserved untouched.
 *
 * Not auto-run in CI or a git hook — re-run manually when tailwind.config.ts / globals.css change.
 *
 * Usage:
 *   npm run docs:tokens
 */

import * as fs from 'node:fs';
import config from '../tailwind.config';

const OUTPUT_PATH = 'DESIGN-TOKENS.md';
const GLOBALS_CSS_PATH = 'src/app/globals.css';
const GENERATED_START = '<!-- GENERATED:START -->';
const GENERATED_END = '<!-- GENERATED:END -->';

type ColorValue = string | Record<string, string>;

function readCssVars(): Map<string, string> {
  const css = fs.readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const rootBlockMatch = css.match(/:root\s*\{([^}]+)\}/);
  const block = rootBlockMatch?.[1] ?? '';
  const varPattern = /--([\w-]+):\s*([^;]+);/g;
  const vars = new Map<string, string>();
  for (const match of block.matchAll(varPattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) vars.set(name, value.trim());
  }
  return vars;
}

function resolveVar(cssVars: Map<string, string>, varRef: string): string {
  const match = varRef.match(/^var\(--([\w-]+)\)$/);
  const name = match?.[1];
  if (name === undefined) return varRef;
  return cssVars.get(name) ?? '(unresolved)';
}

function renderColorsTable(cssVars: Map<string, string>): string {
  const colors = (config.theme?.extend?.colors ?? {}) as Record<string, ColorValue>;
  const rows: string[] = [
    '| Token | Class | CSS Variable | Light Value |',
    '|-------|-------|--------------|-------------|',
  ];
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      rows.push(`| \`${key}\` | \`bg-${key}\` | \`${value}\` | \`${resolveVar(cssVars, value)}\` |`);
      continue;
    }
    if (value.DEFAULT !== undefined) {
      rows.push(
        `| \`${key}\` | \`bg-${key}\` | \`${value.DEFAULT}\` | \`${resolveVar(cssVars, value.DEFAULT)}\` |`
      );
    }
    if (value.foreground !== undefined) {
      rows.push(
        `| \`${key}-foreground\` | \`text-${key}-foreground\` | \`${value.foreground}\` | \`${resolveVar(cssVars, value.foreground)}\` |`
      );
    }
  }
  return rows.join('\n');
}

function renderBorderRadiusTable(cssVars: Map<string, string>): string {
  const borderRadius = (config.theme?.extend?.borderRadius ?? {}) as Record<string, string>;
  const rows: string[] = ['| Token | Class | Value |', '|-------|-------|-------|'];
  for (const [key, value] of Object.entries(borderRadius)) {
    rows.push(`| \`${key}\` | \`rounded-${key}\` | \`${value}\` |`);
  }
  const radiusVar = cssVars.get('radius');
  rows.push(`| \`--radius\` (base) | — | \`${radiusVar ?? '(unresolved)'}\` |`);
  return rows.join('\n');
}

function renderSpacingTypographyNote(): string {
  return [
    '### Spacing & Typography',
    '',
    "No custom spacing or typography scale is defined in `tailwind.config.ts` (no `theme.extend.spacing` or `theme.extend.fontSize` block exists) — the project uses Tailwind's default spacing scale (4px increments) and default type scale (`text-xs`…`text-lg`, `font-normal`/`font-medium`/`font-semibold`/`font-bold`) unmodified.",
  ].join('\n');
}

function buildGeneratedMarkdown(): string {
  const cssVars = readCssVars();
  return [
    '### Colors',
    '',
    renderColorsTable(cssVars),
    '',
    '### Border Radius',
    '',
    renderBorderRadiusTable(cssVars),
    '',
    renderSpacingTypographyNote(),
  ].join('\n');
}

function main(): void {
  const existing = fs.readFileSync(OUTPUT_PATH, 'utf-8');
  const generatedMarkdown = buildGeneratedMarkdown();
  const markerBlock = new RegExp(`${GENERATED_START}[\\s\\S]*${GENERATED_END}`);
  if (!markerBlock.test(existing)) {
    throw new Error(`${OUTPUT_PATH} is missing ${GENERATED_START}/${GENERATED_END} markers.`);
  }
  const updated = existing.replace(markerBlock, `${GENERATED_START}\n${generatedMarkdown}\n${GENERATED_END}`);
  fs.writeFileSync(OUTPUT_PATH, updated, 'utf-8');

  const colorCount = Object.keys(config.theme?.extend?.colors ?? {}).length;
  const radiusCount = Object.keys(config.theme?.extend?.borderRadius ?? {}).length;
  console.log('Design Tokens Generator');
  console.log(`  Colors: ${colorCount} tokens`);
  console.log(`  Border radius: ${radiusCount} tokens`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
