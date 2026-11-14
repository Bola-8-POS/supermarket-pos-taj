/**
 * Grounding guard: a 1B model copies few-shot values into free-text and numeric args. Every such arg must be
 * in what the staff actually typed. Ungrounded optional args are dropped (null); an ungrounded required arg
 * makes the whole proposal null (the caller asks the staff to clarify; nothing runs with an invented value).
 * Pure module (shared by the app and the eval runner).
 */
import { numbersInText } from './number-words';
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

const SORT_WORDS: Record<'stock_low' | 'newest', RegExp> = {
  stock_low: /\b(low|lowest|least|fewest|poco|pocos|poca|pocas|bajo|baja|menos|menor|running)\b/,
  newest: /\b(new|newest|latest|recent|recently|nuevo|nuevos|nueva|nuevas|reciente|recientes|ultimo|ultimos)\b/,
};

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
      const sortOk = sort !== null && sort !== 'name' && SORT_WORDS[sort].test(norm(userText));
      return {
        kind: 'product.list',
        args: { query: text(query), limit: count(limit), sort: sortOk ? sort : null },
      };
    }
    case 'sales.recent':
      return { kind: 'sales.recent', args: { limit: count(proposal.args.limit) } };
    case 'inventory.adjust':
      return proposal.args.items.every(i => text(i.query) !== null && nums.includes(Math.abs(i.delta))) ? proposal : null;
    case 'product.price':
      return proposal.args.items.every(
        i => text(i.query) !== null && nums.some(n => Math.round(n * 100) === i.priceCents)
      )
        ? proposal
        : null;
  }
}
