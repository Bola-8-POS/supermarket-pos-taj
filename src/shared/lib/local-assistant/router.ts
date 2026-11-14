/**
 * Deterministic keyword pre-router. A confident match returns the same `Proposal` the model would have emitted;
 * everything after it (schema, grounding, RBAC in `decide`, the manager PIN approval for writes) is unchanged, so
 * the router can neither skip approval nor widen what a role may do. No confident match, or two intents matching,
 * returns null and the turn falls through to the model. Pure module (shared by the app and the eval runner).
 */
import { ground, lev1, SORT_WORDS, STOCK_WORD, UNMAPPED_RANK } from './grounding';
import { foldText, normalizeNumberSeparators, numberWordsToDigits } from './number-words';
import { PERCENT_OFF_MAX, PERCENT_OFF_MIN, Proposal } from './proposal';

/** Words the patterns key on; a token of 5+ letters one edit away from one of these is read as that word. */
const VOCAB = new Set(
  (
    'precio precios cuesta cuestan existencia existencias inventario inventory producto productos products product ' +
    'articulos items stock price prices cost expire expires expiring expired expiry caduca caducan caducar caducidad ' +
    'caducados caducadas vence vencen vencer vencimiento ventas vendimos vendido vendio vende vendes venden cuanto ' +
    'cuantos cuantas ultima ultimo ultimas ultimos latest recent payment payments summary resumen tienes tenemos ' +
    'quedan baja bajar merma update change remove discard tomorrow manana today semana month newest nuevos nuevas ' +
    'muestra muestrame ensename listar display reorder restock available proveedor supplier running lowest orders ' +
    'ticket tickets cobros pagos ordenes reporte report corte cambia cambiar actualiza ajusta modifica write'
  ).split(' ')
);

function fixToken(t: string): string {
  if (t === 'q' || t === 'k') return 'que';
  if (t.length < 5 || !/^[a-z]+$/.test(t) || VOCAB.has(t)) return t;
  for (const w of VOCAB) if (w.length >= 5 && lev1(t, w)) return w;
  return t;
}

/** Aligned token lists: `o` is what the staff typed (number words as digits), `f` the typo-fixed form patterns see. */
type Prep = { s: string; f: string[]; o: string[] };

function prep(text: string): Prep {
  const raw = normalizeNumberSeparators(foldText(text).replace(/[^a-z0-9.,\s-]/g, ' ').replace(/-/g, ' '))
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const o = numberWordsToDigits(raw);
  const f = o.map(fixToken);
  return { s: f.join(' '), f, o };
}

/** Lowercase, accent-free, punctuation-free, number words as digits, light typos and slang fixed. */
export const normalize = (text: string): string => prep(text).s;

const spaces = (s: string): number => (s.match(/ /g) ?? []).length;
/** Tokens that end at or before char `end` (a word boundary). */
const tokensUpTo = (s: string, end: number): number => (end === 0 ? 0 : spaces(s.slice(0, end)) + 1);

/** The typed words of capture group `g`: aligned back to `o` so a product name is never rewritten by typo fixing. */
function typed(p: Prep, m: RegExpExecArray, g = 1): string[] | undefined {
  const ix = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices?.[g];
  if (!ix) return undefined;
  const a = spaces(p.s.slice(0, ix[0]));
  return p.o.slice(a, a + p.s.slice(ix[0], ix[1]).split(' ').length);
}

const rx = (src: string): RegExp => new RegExp(src, 'd');

/** Nouns that name "the products" rather than one product or supplier. */
const GENERIC = new Set(
  (
    'product products producto productos item items articulo articulos price prices precio precios stock existencia ' +
    'existencias inventory inventario list lista the el la los las de del of for a an un una supplier proveedor all ' +
    'todo todos todas everything any algo something nuevo nuevos nueva nuevas bajo baja poco poca pocos pocas low menos ' +
    'barcode codigo code sku today hoy tomorrow manana yesterday ayer week semana month mes'
  ).split(' ')
);
const LEAD = new Set('the a an any some el la los las un una unos unas de del al of for'.split(' '));
const UNIT_NOUNS = new Set(
  'unit units bottle bottles pack packs box boxes can cans bag bags piece pieces unidad unidades botella botellas paquete paquetes caja cajas lata latas bolsa bolsas pieza piezas'.split(' ')
);
const TAIL = new Set(
  'please pls porfa favor por left available stock in en existencia existencias now ahora ahorita right hay quedan tenemos tienes tiene have we you do does are is there store shop tienda la el'.split(' ')
);
const NOT_A_PRODUCT = new Set('que como cuando donde quien what how when where who why low poco poca pocos pocas bajo baja menos'.split(' '));
const MAX_QUERY_WORDS = 6;

/** A product/supplier name from typed words, or null when nothing but generic words (or a sentence) is left. */
function cleanQuery(words: string[] | undefined, drop: ReadonlySet<string> = new Set()): string | null {
  if (!words) return null;
  let t = words.filter(w => !drop.has(w));
  const trim = (): boolean => {
    const unitOf = t.length > 1 && UNIT_NOUNS.has(t[0] ?? '') && (t[1] === 'of' || t[1] === 'de');
    if (unitOf) t = t.slice(2);
    else if (t.length > 0 && LEAD.has(t[0] ?? '')) t = t.slice(1);
    else if (t.length > 0 && TAIL.has(t[t.length - 1] ?? '')) t = t.slice(0, -1);
    else return false;
    return true;
  };
  while (trim()) continue;
  const named = t.filter(w => !GENERIC.has(w));
  const first = t[0] ?? '';
  if (named.length === 0 || t.length > MAX_QUERY_WORDS || NOT_A_PRODUCT.has(first)) return null;
  return t.filter(w => !(w === 'barcode' || w === 'codigo' || w === 'code' || w === 'sku')).join(' ');
}

const firstInt = (f: string[], min: number, max: number): number | null => {
  const n = f.map(t => (/^\d+$/.test(t) ? parseInt(t, 10) : NaN)).find(x => x >= min && x <= max);
  return n ?? null;
};

// ---- writes (proposals only: the manager PIN approval stays in the gateway) ----

const WO_STRONG = rx('\\b(?:write ?(?:off|down)|da(?:r|me|le|rle)? de baja|merma|desech\\w+|throw (?:away|out)|discard|scrap)\\b');
const WO_WEAK = rx('\\b(?:remove|baja(?:r|n)?|quita(?:r)?|saca(?:r)?|tira(?:r)?)(?= \\d)');
const WASTE = new Set('expired expirado expirados caducado caducados caducada caducadas vencido vencidos vencida vencidas spoiled bad damaged broken rotten stale danado danados podrido podridos'.split(' '));
const SEPARATOR = new Set(['and', 'y']);

function parseWriteOff(p: Prep, m: RegExpExecArray): Proposal | null {
  const consumed = tokensUpTo(p.s, m.indices?.[0]?.[1] ?? 0);
  const items: { query: string; delta: number }[] = [];
  let a = consumed;
  for (let i = consumed; i <= p.f.length; i++) {
    if (i < p.f.length && !SEPARATOR.has(p.f[i] ?? '')) continue;
    const f = p.f.slice(a, i);
    const o = p.o.slice(a, i);
    a = i + 1;
    const lead = f[0] === 'de' || f[0] === 'of' ? 1 : 0;
    const qty = /^\d+$/.test(f[lead] ?? '') ? parseInt(f[lead] ?? '', 10) : NaN;
    const query = cleanQuery(o.slice(lead + 1), new Set([...WASTE, 'from', 'del', 'out']));
    if (!Number.isInteger(qty) || qty < 1 || query === null) return null;
    items.push({ query, delta: -qty });
  }
  const waste = p.f.some(t => WASTE.has(t)) || /\b(?:write ?off|merma|baja|desech\w+|discard|scrap|throw)/.test(p.s);
  return { kind: 'inventory.adjust', args: { reason: waste ? 'waste' : 'manual_adjustment', items } };
}

const PRICE_VERB = /\b(?:set|change|update|make|put|raise|lower|reduce|increase|adjust|reprice|mark|cambia\w*|sube|subir|subele|bajar|bajale|baja|ajusta\w*|actualiza\w*|modifica\w*|ponle|pon|poner|ponerle|deja|marca)\b/;
const PRICE_SIGNAL = /\b(?:prices?|precios?|cost|pesos)\b|\b(?:to|at|a|en|por) \d/;
const NUM = '(\\d+(?:\\.\\d+)?)';
const PRICE_EN = rx(`\\b(?:set|change|update|make|put|raise|lower|reduce|increase|adjust|reprice|mark)\\s+(?:the\\s+)?(?:(?:price|prices|cost)\\s+)?(?:(?:of|for|on)\\s+)?(.+?)\\s+(?:to|at)\\s+${NUM}(?:\\s+(?:pesos|mxn|each|dollars))?$`);
const PRICE_ES = rx(`\\b(?:cambia\\w*|pon(?:er|le|erle)?|sube|subir|subele|bajar|bajale|baja|ajusta\\w*|actualiza\\w*|modifica\\w*|deja|marca)\\s+(?:el\\s+|los\\s+|la\\s+|las\\s+)?(?:(?:precio|precios)\\s+)?(?:(?:de|del|a|al|para)\\s+(?:la\\s+|el\\s+|los\\s+|las\\s+)?)?(.+?)\\s+(?:a|en|por)\\s+${NUM}(?:\\s+pesos)?$`);
const PRICE_ES_FIRST = rx(`\\b(?:ponle|ponerle|pon|poner)\\s+${NUM}\\s+(?:pesos\\s+)?(?:al|a la|a los|a las|a|para)\\s+(.+)$`);

function parsePrice(p: Prep): Proposal | null {
  const hit = PRICE_EN.exec(p.s) ?? PRICE_ES.exec(p.s);
  const first = hit ? null : PRICE_ES_FIRST.exec(p.s);
  const m = hit ?? first;
  if (!m) return null;
  const words = typed(p, m, first ? 2 : 1);
  const query = cleanQuery(words);
  const price = parseFloat((first ? m[1] : m[2]) ?? '');
  if (query === null || /\b(?:and|y)\b/.test(query) || !Number.isFinite(price)) return null;
  return { kind: 'product.price', args: { items: [{ query, priceCents: Math.round(price * 100), percentOff: null }] } };
}

// ---- percent discount (a permanent price change; the gateway computes the new price from the current one) ----

const PCT = '(\\d+(?:\\.\\d+)?) percent';
const ART = '(?:(?:la|el|los|las)\\s+)?';
/** Each form: the regex, which capture group is the percent (`n`) and which the product (`q`), and whether it needs descuento/rebaja. */
const DISCOUNTS: { re: RegExp; n: number; q: number; needsWord: boolean }[] = [
  // "put 10 percent discount on X", "give 15 percent off on X", "take 20 percent off X", "10 percent off X"
  { re: rx(`\\b(?:(?:put|give|apply|add|take|do|make|set)\\s+)?(?:(?:a|an|the)\\s+)?${PCT}\\s+(?:discount|off|rebate|sale|reduction)\\s*(?:(?:on|for|to|off|from|of)\\s+)?(?:the\\s+)?(.+)$`), n: 1, q: 2, needsWord: false },
  // "reduce the price of X by 5 percent", "discount X 10 percent", "lower X by 5 percent"
  { re: rx(`\\b(?:reduce|lower|cut|drop|decrease|discount|mark ?down)\\s+(?:the\\s+)?(?:price\\s+)?(?:(?:of|for|on)\\s+)?(.+?)\\s+(?:by\\s+)?${PCT}$`), n: 2, q: 1, needsWord: false },
  // "baja 25% el precio del X", "rebaja 10% al X"
  { re: rx(`\\b(?:baja\\w*|rebaja\\w*|reduce|reducir|disminuye|descuenta|quita)\\s+(?:un\\s+)?${PCT}\\s+${ART}(?:precios?\\s+)?(?:(?:de|del|a|al|para)\\s+)?${ART}(.+)$`), n: 1, q: 2, needsWord: false },
  // "ponle 10% de descuento a X", "descuento del 12% para X", "hazle una rebaja de 30% a X"
  { re: rx(`\\b(?:(?:ponle|ponerle|pon|poner|dale|dar|aplica\\w*|hazle|haz|agrega\\w*)\\s+)?(?:(?:un|una|el)\\s+)?(?:(?:descuento|rebaja)\\s+(?:de|del)\\s+)?${PCT}(?:\\s+de)?(?:\\s+(?:descuento|rebaja))?\\s+(?:a|al|para|en|de|del)\\s+${ART}(.+)$`), n: 1, q: 2, needsWord: true },
];
const DISCOUNT_WORD = /\b(?:descuento|rebaja)\b/;
const POLITE = new Set('please pls porfa por favor can could would you puedes podrias me nos ok okay hey'.split(' '));

/**
 * undefined: not a percent request; otherwise the proposal, a refusal (percent outside 1-90 or not whole), or null
 * (a percent request whose product is missing: the model gets it and the grounding guard asks).
 */
function parseDiscount(text: string): Proposal | null | undefined {
  // "%" is rewritten here only, so a product named "2% milk" is untouched on every other path.
  const p = prep(text.replace(/(\d)\s*%/g, '$1 percent ').replace(/\bpor ?ciento\b/gi, ' percent '));
  for (const { re, n, q, needsWord } of DISCOUNTS) {
    const m = re.exec(p.s);
    if (!m || (needsWord && !DISCOUNT_WORD.test(p.s))) continue;
    // The request starts at the verb or the percent: "ghee gets 10% off for the sale" names no product after it.
    if (!p.s.slice(0, m.index).split(' ').every(w => w === '' || POLITE.has(w))) continue;
    // "reduce ghee stock by 10%" is a stock change, never a price discount.
    if (STOCK_WORD.test(p.s)) return { kind: 'refuse', reason: 'unsupported' };
    const pct = parseFloat(m[n] ?? '');
    const query = cleanQuery(typed(p, m, q));
    if (query === null || /\b(?:and|y)\b/.test(query)) return null;
    if (!Number.isInteger(pct) || pct < PERCENT_OFF_MIN || pct > PERCENT_OFF_MAX) return { kind: 'refuse', reason: 'unsupported' };
    return { kind: 'product.price', args: { items: [{ query, priceCents: null, percentOff: pct }] } };
  }
  return undefined;
}

/** undefined: no write verb here; null: a write verb but not a complete, unambiguous request; else the proposal. */
function writeIntent(p: Prep): Proposal | null | undefined {
  const wo = WO_STRONG.exec(p.s) ?? WO_WEAK.exec(p.s);
  const pc = PRICE_VERB.test(p.s) && PRICE_SIGNAL.test(p.s);
  if (!wo && !pc) return undefined;
  if (wo && pc) return null; // both kinds of write in one sentence: the model decides
  return wo ? parseWriteOff(p, wo) : parsePrice(p);
}

// ---- reads ----

const lookupSources = [
  '\\b(?:price|prices|cost|costs|precio|precios)\\s+(?:of|for|de|del|para)\\s+(.+)$',
  '\\bhow much (?:is|are|does|do|for)\\s+(.+?)(?:\\s+(?:cost|costs|each|now))?$',
  '\\bcuant[oa]s? (?:cuesta|cuestan|vale|valen|sale|salen|cobran)\\s+(.+)$',
  '\\b(?:do|does|did) (?:we|you|they) (?:have|carry|sell|stock)\\s+(.+)$',
  '\\b(?:got|have (?:we|you) got|is there|are there)\\s+(.+)$',
  '\\b(?:hay|tienes|tiene|tienen|tenemos|manejan|manejas|venden|vendes)\\s+(.+)$',
  '(?<!\\b(?:poco|poca|pocos|pocas|low|lowest|bajo|baja|menos)\\s)\\b(?:stock|existencias?|inventario|disponibilidad|availability)\\s+(?:of|for|de|del|para)\\s+(.+)$',
  '\\bhow many\\s+(.+?)\\s+(?:do we have|have we got|are there|are left|are in stock|in stock|we have|left|do you have|remain|are available)$',
  '\\bcuant[oa]s?\\s+(.+?)\\s+(?:hay|quedan|tenemos|tienen|tienes|existen|nos quedan|me quedan)$',
].map(rx);

function lookup(p: Prep): Proposal | undefined {
  for (const re of lookupSources) {
    const m = re.exec(p.s);
    const query = m ? cleanQuery(typed(p, m)) : null;
    if (query !== null) return { kind: 'product.lookup', args: { query } };
  }
  return undefined;
}

const LOW = rx(
  '\\blow (?:on |in |of )?(?:stock|inventory)\\b|\\b(?:stock|inventory) (?:is |are |running )?low\\b|\\brunning (?:low|out)\\b|\\bout of stock\\b|\\balmost out\\b|' +
    '\\bneeds? (?:to )?(?:re ?order|restock)\\b|\\bre ?order\\b|\\brestock\\b|\\b(?:poco|poca|pocos|pocas|bajo|baja) (?:stock|existencias?|inventario)\\b|' +
    '\\b(?:stock|existencias?|inventario) (?:bajo|baja|minimo)\\b|\\bacabando\\b|\\bagotando\\b|\\bagotad[oa]s?\\b|\\bsin (?:stock|existencias?)\\b|' +
    '\\bresurtir\\b|\\breabastecer\\b|\\breponer\\b|\\bpor acabarse\\b|\\bse acaban?\\b'
);
const SUPPLIER = rx('\\b(?:from|by|de|del|supplier|proveedor|vendor|of)\\s+(.+)$');

function lowStock(p: Prep): Proposal | undefined {
  const m = LOW.exec(p.s);
  if (!m) return undefined;
  const consumed = tokensUpTo(p.s, m.indices?.[0]?.[1] ?? 0);
  const tail: Prep = { s: p.f.slice(consumed).join(' '), f: p.f.slice(consumed), o: p.o.slice(consumed) };
  const sm = SUPPLIER.exec(tail.s);
  return { kind: 'stock.low', args: { supplierQuery: sm ? cleanQuery(typed(tail, sm)) : null } };
}

const EXPIRY = /\b(?:expir\w*|caduc\w*|venc\w*|best before|use by)\b/;

function expiry(p: Prep): Proposal | undefined {
  if (!EXPIRY.test(p.s)) return undefined;
  const n = /\b(\d+) (?:days?|dias?)\b/.exec(p.s);
  const withinDays = n
    ? parseInt(n[1] ?? '', 10)
    : /\b(?:today|hoy)\b/.test(p.s)
      ? 0
      : /\b(?:tomorrow|manana)\b/.test(p.s)
        ? 1
        : /\b(?:week|semana)\b/.test(p.s)
          ? 7
          : /\b(?:month|mes)\b/.test(p.s)
            ? 30
            : null;
  return { kind: 'expiry.list', args: { withinDays } };
}

const SUMMARY = rx(
  '\\bhow much (?:money )?(?:did|have|do) we (?:sell|sold|make|made|take|earn)\\b|\\b(?:sales|revenue|takings|income) (?:total|summary|report|today|so far|for)\\b|' +
    '\\b(?:daily|total|todays?|day|today) (?:sales|revenue|takings|summary|report)\\b|\\b(?:cash|register|till|caja) (?:summary|report|total)\\b|\\bend of day\\b|' +
    '\\bcuanto (?:llevamos|vendimos|vendio|se vendio|se ha vendido|hemos vendido|hicimos|vendi)\\b|\\bresumen (?:de |del )?(?:caja|ventas|dia|turno)\\b|' +
    '\\bcorte (?:de )?caja\\b|\\bcierre de caja\\b|\\bventas? (?:totales|total|del dia|de hoy|hoy)\\b|\\btotal (?:de )?ventas\\b|\\breporte (?:de )?(?:ventas|caja)\\b'
);
const RECENT = /\b(?:last|latest|previous|recent|most recent|ultim\w*|anterior(?:es)?)(?: \d+)? (?:sales?|payments?|orders?|transactions?|tickets?|ventas?|cobros?|pagos?|ordenes|orden|transacci(?:on|ones))\b/;

const LIST_VERB = /\b(?:show|list|give|display|see|view|get|print|dame|damelos|muestra\w*|ensena\w*|lista\w*|enlista\w*|dime|ver|mostrar|pasame|mandame)\b/;
const LIST_NOUN = /\b(?:products|items|articles|productos|articulos|inventory|catalog|catalogo|product prices|prices|precios)\b/;
const RANK = /\b(?:lowest|least|fewest|menos|menor)\b/;

/** Words that may sit around a price-sorted list request; anything else (a category, a brand) sends it to the model. */
const PRICE_FILLER = new Set(
  ('the a an me my i we you have has got in store shop tienda tengo tenemos tienes tiene hay con que mas more most least ' +
    'lowest highest expensive price priced cost menor mayor precio precios bajos altos bajo alto please porfa favor are is what ' +
    'which cuales cual son es de del la el los las en first primeros top for of with by sorted best mejor mejores').split(' ')
);

function list(p: Prep): Proposal | undefined {
  const rank = RANK.test(p.s) && STOCK_WORD.test(p.s);
  const newest = SORT_WORDS.newest.test(p.s);
  const price = SORT_WORDS.price_asc.test(p.s) ? 'price_asc' : SORT_WORDS.price_desc.test(p.s) ? 'price_desc' : null;
  if (price && (rank || newest)) return undefined; // two rankings at once: the model decides
  if (!LIST_NOUN.test(p.s) || !(LIST_VERB.test(p.s) || rank || newest || price)) return undefined;
  // A ranking no sort can honour ("best selling products"): a clear refusal, not a name-sorted list or a wrong intent.
  if (!price && !rank && !newest && UNMAPPED_RANK.test(p.s)) return { kind: 'refuse', reason: 'unsupported' };
  if (price) {
    const known = (t: string): boolean =>
      /^\d+$/.test(t) || PRICE_FILLER.has(t) || LIST_NOUN.test(t) || LIST_VERB.test(t) || SORT_WORDS[price].test(t);
    if (!p.f.every(known)) return undefined;
  }
  return {
    kind: 'product.list',
    args: { query: null, limit: firstInt(p.f, 1, 50), sort: price ?? (rank ? 'stock_low' : newest ? 'newest' : null) },
  };
}

function reads(p: Prep): Proposal | null | undefined {
  const recent = RECENT.test(p.s) ? ({ kind: 'sales.recent', args: { limit: firstInt(p.f, 1, 20) } } as const) : undefined;
  const summary = recent || !SUMMARY.test(p.s) ? undefined : ({ kind: 'sales.summary', args: {} } as const);
  const hits = [lowStock(p), expiry(p), summary, recent, lookup(p)].filter((x): x is Proposal => x !== undefined);
  if (hits.length > 1) return null; // ambiguous: the model decides
  return hits[0] ?? list(p);
}

/**
 * A proposal for a confidently recognised request, or null (no match, ambiguous, invalid, or an argument the
 * text does not ground). The caller still runs `decide` on the result.
 */
export function route(text: string): Proposal | null {
  const p = prep(text);
  const discount = parseDiscount(text);
  const found = discount === undefined ? writeIntent(p) : discount;
  const candidate = found === undefined ? reads(p) : found;
  if (!candidate) return null;
  const valid = Proposal.safeParse(candidate);
  return valid.success ? ground(valid.data, text) : null;
}
