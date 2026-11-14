/**
 * Grounding guard: a 1B model copies few-shot values into free-text and numeric args. Every such arg must be
 * in what the staff actually typed. Ungrounded optional args are dropped (null); an ungrounded required arg
 * makes the whole proposal null (the caller asks the staff to clarify; nothing runs with an invented value).
 * Pure module (shared by the app and the eval runner).
 */
import { normalizeNumberSeparators, numbersInText, numberWordsToDigits } from './number-words';
import type { Proposal } from './proposal';

const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s: string): string[] => norm(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Singular guesses, so "tomatoes", "leches" and "leche" meet. Short words are left alone. */
const forms = (w: string): string[] => (w.length > 3 ? [w, w.replace(/s$/, ''), w.replace(/es$/, '')] : [w]);

export function lev1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

function sameWord(a: string, b: string): boolean {
  const fb = forms(b);
  if (forms(a).some(f => fb.includes(f))) return true;
  return a.length >= 5 && b.length >= 5 && lev1(a, b); // ponytail: one-typo tolerance, no phonetic matching
}

/** Words that name the kind of thing asked for, not a product or supplier: a value made only of these is empty. */
const GENERIC = new Set(
  (
    'product products producto productos item items articulo articulos price prices precio precios stock ' +
    'existencia existencias inventory inventario list lista the el la los las de del of for a an un una ' +
    'supplier proveedor all todo todos null none'
  ).split(' ')
);

/** The value's meaningful words (generic ones removed). */
const meaningful = (value: string): string[] => words(value).filter(w => !GENERIC.has(w));

/** True when the value has at least one meaningful word and every one of them is in the message. */
function textGrounded(value: string, messageWords: string[]): boolean {
  const need = meaningful(value);
  return need.length > 0 && need.every(w => messageWords.some(m => sameWord(w, m)));
}


/** Time words the staff use instead of a day count. */
const DAY_WORDS: Record<string, number> = { hoy: 0, today: 0, manana: 1, tomorrow: 1, semana: 7, week: 7, mes: 30, month: 30 };

// Sort words are PHRASES, never bare adjectives: "the new supplier", "low fat" and "al por mayor" are not rankings.
const STOCK_NOUN = '(?:stock|inventory|existencias?|inventario|units|unidades)';
export const SORT_WORDS: Record<'stock_low' | 'newest' | 'price_asc' | 'price_desc', RegExp> = {
  stock_low: new RegExp(
    `\\b(?:(?:low|lowest|least|fewest|poco|pocos|poca|pocas|bajo|baja|menos|menor|menores)\\s+(?:(?:in|on|en)\\s+)?${STOCK_NOUN}|running (?:low|out)|${STOCK_NOUN} (?:bajo|baja|low))\\b`
  ),
  newest:
    /\b(?:newest|latest|most recent|recently (?:added|created)|new (?:products|items|arrivals)|(?:products|items|productos|articulos) (?:nuevos|nuevas|recientes)|(?:nuevos|nuevas|ultimos|recientes) (?:productos|articulos)|mas (?:nuevos?|nuevas?|recientes?)|ultimos agregados|recien (?:agregados|llegados))\b/,
  price_asc:
    /\b(?:cheap|cheapest|cheaper|inexpensive|lowest priced?|lowest (?:price|cost)|least expensive|best prices?|barato|baratos|barata|baratas|economico|economicos|economica|economicas|menor precio|mejor(?:es)? precios?|precios? mas bajos?|menos caros?)\b/,
  price_desc:
    /\b(?:expensive|priciest|pricey|costly|costliest|highest priced?|highest (?:price|cost)|caro|caros|cara|caras|costoso|costosos|costosa|costosas|mayor precio|precios? mas altos?)\b/,
};
/** Ranking words no sort here can honour ("best selling"): a list asking for one is never answered name-sorted. */
export const UNMAPPED_RANK = /\b(?:best|bestsellers?|top|most|highest|biggest|largest|popular|oldest|worst|mejor|mejores|vendidos?|populares|antiguos?)\b|(?<!por )\bmayor(?:es)?\b/;
/** Price sort words always win over the stock words ("lowest price" is not "lowest stock"). */
const isPriceSort = (t: string): boolean => SORT_WORDS.price_asc.test(t) || SORT_WORDS.price_desc.test(t);
/** A stock/inventory word: a quantity change, never a price discount. */
export const STOCK_WORD = new RegExp(`\\b${STOCK_NOUN}\\b`);
/** Words that make a typed percent a reduction, and the ones that make it an increase (not supported). */
const REDUCE_WORD = /\b(?:off|discount|descuento|rebaja\w*|baja\w*|bajale|reduce|reduced|reducir|less|menos|lower|cut|drop|decrease|markdown|mark down|disminuye|descuenta|quita)\b/;
const INCREASE_WORD = /\b(?:raise|increase|increased|sube|subir|subele|aumenta\w*|incrementa\w*|up|more|mas|higher)\b/;
/** The percent values the staff typed with a percent marker ("10%", "10 percent", "10 por ciento"); "1,5%" is 1.5. */
const typedPercents = (t: string): number[] =>
  [...normalizeNumberSeparators(t).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent|pct|por ?ciento)/g)].map(m => parseFloat(m[1] ?? ''));

export function ground(proposal: Proposal, userText: string): Proposal | null {
  const mw = words(userText);
  const nums = numbersInText(userText);
  const text = (v: string | null): string | null => (v !== null && textGrounded(v, mw) ? v : null);
  const count = (n: number | null): number | null => (n !== null && nums.includes(n) ? n : null);

  switch (proposal.kind) {
    case 'refuse':
    case 'sales.summary':
      return proposal;
    case 'product.lookup':
      return text(proposal.args.query) === null ? null : proposal;
    case 'stock.low':
      return { kind: 'stock.low', args: { supplierQuery: text(proposal.args.supplierQuery) } };
    case 'expiry.list': {
      const d = proposal.args.withinDays;
      const byWord = d !== null && mw.some(w => DAY_WORDS[w] === d);
      return { kind: 'expiry.list', args: { withinDays: byWord ? d : count(d) } };
    }
    case 'product.list': {
      const { query, limit, sort } = proposal.args;
      const t = norm(userText);
      const q = text(query);
      const sortOk =
        sort !== null && sort !== 'name' && SORT_WORDS[sort].test(t) && !(sort === 'stock_low' && isPriceSort(t));
      if (!sortOk) {
        // The staff asked for a ranking the list cannot give: ask, never answer with a name-sorted list.
        const rest = q === null ? t : t.replace(norm(q), ' ');
        if (Object.values(SORT_WORDS).some(re => re.test(rest)) || UNMAPPED_RANK.test(rest)) return null;
      }
      return { kind: 'product.list', args: { query: q, limit: count(limit), sort: sortOk ? sort : null } };
    }
    case 'sales.recent':
      return { kind: 'sales.recent', args: { limit: count(proposal.args.limit) } };
    case 'inventory.adjust':
      return proposal.args.items.every(i => text(i.query) !== null && nums.includes(Math.abs(i.delta))) ? proposal : null;
    case 'product.price': {
      const t = norm(userText);
      const items = proposal.args.items.map(i => {
        const priceTyped = nums.some(n => Math.round(n * 100) === i.priceCents);
        if (i.percentOff === null) return priceTyped ? i : null;
        // The percent counts only outside the product name ("2% milk"), with a reduction word and no increase or stock word.
        const rest = norm(i.query) === '' ? t : t.replace(norm(i.query), ' ');
        const percents = typedPercents(numberWordsToDigits(rest.split(/\s+/)).join(' '));
        const isDiscount =
          percents.includes(i.percentOff) && REDUCE_WORD.test(rest) && !INCREASE_WORD.test(rest) && !STOCK_WORD.test(rest);
        // A discount wins: the model's absolute price is dropped, the gateway computes it from the current price.
        if (isDiscount) return { ...i, priceCents: null };
        return priceTyped && percents.length === 0 ? { ...i, percentOff: null } : null;
      });
      const grounded = proposal.args.items.every((i, k) => text(i.query) !== null && items[k] !== null);
      return grounded ? { kind: 'product.price', args: { items: items.flatMap(i => (i ? [i] : [])) } } : null;
    }
  }
}
