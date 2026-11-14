/**
 * Number words 1-50 in English and Spanish ("twelve", "doce", "treinta y cinco") for the router and the grounding
 * guard. Pure module. Input tokens are already lowercase and accent-free.
 */
const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, treinta: 30, cuarenta: 40, cincuenta: 50, veinte: 20 };

export const foldText = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Replaces each number word (or "tens + unit" pair) with its digits; every other token is untouched. */
export function numberWordsToDigits(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    const tens = TENS[t];
    if (tens !== undefined) {
      // "thirty five" / "treinta y cinco"
      const joiner = tokens[i + 1] === 'y' || tokens[i + 1] === 'and' ? 1 : 0;
      const unit = UNITS[tokens[i + 1 + joiner] ?? ''];
      if (unit !== undefined && unit < 10) {
        out.push(String(tens + unit));
        i += 1 + joiner;
        continue;
      }
    }
    const n = UNITS[t];
    out.push(n !== undefined ? String(n) : tens !== undefined ? String(tens) : t);
  }
  return out;
}

/**
 * The one decimal/thousands rule: "1,500" is 1500 (comma + exactly three digits), "12,50" is 12.5.
 * The router and grounding both use it, so the price staff typed and the price grounding accepts never differ.
 */
export const normalizeNumberSeparators = (s: string): string =>
  s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '').replace(/(\d),(\d)/g, '$1.$2');

/** Every number the text states, as digits (12, 12.5, 12,5, 1,500) or as number words 1-50. */
export function numbersInText(text: string): number[] {
  const tokens = normalizeNumberSeparators(foldText(text)).match(/[\p{L}\p{N}]+(?:\.\d+)?/gu) ?? [];
  const joined = numberWordsToDigits(tokens).join(' ');
  return (joined.match(/\d+(?:\.\d+)?/g) ?? []).map(n => parseFloat(n));
}
