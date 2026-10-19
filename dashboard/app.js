// @ts-check
// The dashboard pages (ARCHITECTURE.md 6.13; the approved design C): the overview, the full ranked
// list, open loops, how we measured, and one drawer of drill layers in which every path ends on a
// message. A plain ES module with no dependencies; it builds every node through el() from viewer.js.
//
// Every figure on the page is a Num from the built data: its text (t) is placed as written, its
// exact text (x) one level down, its kind (k) styles it, and its target (d) is what a click opens.
// The page adds, divides and rounds nothing it reports; its only arithmetic is pixel geometry for
// the step chart, the bars and the timelines. Every string that came from an email or a model goes
// in as a text node. Nothing at the top level touches the DOM, so the tests import the pure helpers
// in Node; the page starts itself when it finds its shell.
//
// Data: data.json at start (the overview paints from it alone); method.json, loops.json, a process
// file and messages/index.json on first use, each fetched once; one message at a time from
// /api/message through the viewer.

import { el, add, messageView, renderMarkdown, lookupForm, pathLine, fetchMessage } from './viewer.js';

/**
 * @typedef {{ kind: string, key?: string, type?: string, person?: string, month?: string, set?: string,
 *   filter?: string, stall_kind?: string, recent?: boolean, drafted?: boolean, id?: string, quote?: string,
 *   action?: string, bucket?: string, section?: string }} Target
 * @typedef {{ v: number, t: string, x?: string, k?: string, d: Target }} Num
 * @typedef {string | number | Node | null | undefined | false | Kid[]} Kid
 * @typedef {{ crumb: string, key?: string, render: () => Kid[], nodes?: Node[], scroll?: number, from?: HTMLElement | null }} Layer
 * @typedef {{ quote?: any, counted_in?: { process?: string, by?: string }, mark?: string }} Ctx
 */

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)
// ---------------------------------------------------------------------------------------------

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "12 Jun 2001" from a stored UTC string, read by its parts and never parsed as a date.
 * @param {string | null | undefined} utc */
export function dateText(utc) {
  const m = typeof utc === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(utc) : null;
  if (m === null) return 'no usable date';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

/** "June 2001" from "2001-06". @param {string} ym */
export function monthText(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  return m === null ? ym : `${MONTHS_LONG[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

/** "Jun 2001" from "2001-06". @param {string} ym */
export function monthShort(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  return m === null ? ym : `${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`;
}

/** Whole days since 1970 for a stored UTC date, for placing it on a timeline (pixel geometry only).
 * @param {string | null | undefined} utc @returns {number | null} */
export function dayNumber(utc) {
  const m = typeof utc === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(utc) : null;
  return m === null ? null : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/** "2001-07" for the month after "2001-06". @param {string} ym */
export function nextMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** "2001-05" for the month before "2001-06". @param {string} ym */
export function prevMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7));
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

/** "1,194": the digits of a count grouped for reading. @param {number} n */
export function grouped(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "7.62" from 762: a stored hundredths value written out exactly (no rounding). @param {number} x */
export function hundredths(x) {
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(x));
  return `${sign}${grouped(Math.trunc(a / 100))}.${String(a % 100).padStart(2, '0')}`;
}

/** "25.7" from 257: a stored tenths value written out exactly. @param {number} x */
export function tenths(x) {
  const a = Math.abs(Math.trunc(x));
  return `${x < 0 ? '-' : ''}${grouped(Math.trunc(a / 10))}.${a % 10}`;
}

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "four" for 4, as the report says it. @param {number} n */
export const numberWord = (n) => SMALL[n] ?? grouped(n);

/** "3 days", "1 day". @param {number} n @param {string} one @param {string} [many] */
export const plural = (n, one, many) => `${grouped(n)} ${n === 1 ? one : (many ?? `${one}s`)}`;

/** The first letter in capitals. @param {string} s */
export const cap = (s) => (s === '' ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`);

/** "Giron, Darron C" read as "Darron C Giron" (the archive's directory form); no name: the address.
 * @param {string | null | undefined} name @param {string} email */
export function personName(name, email) {
  if (name === null || name === undefined || name.trim() === '') return email === '' ? 'unknown sender' : email;
  const m = /^([^,]+),[ \t]*([^,]+)$/.exec(name.trim());
  const s = m === null ? name.trim() : `${(m[2] ?? '').trim()} ${(m[1] ?? '').trim()}`;
  return s.replace(/[ \t]+[–—][ \t]+/g, ', ').replace(/[–—]/g, '-');
}

/**
 * Where a figure's text stands in a sentence, at or after `from`, as a whole figure: not inside a
 * longer number or word ("5" is not found in "15", "1.5" or "$5"). -1 when it is not there.
 * @param {string} text @param {string} figure @param {number} [from]
 */
export function findFigure(text, figure, from = 0) {
  if (figure === '') return -1;
  for (let i = text.indexOf(figure, from); i >= 0; i = text.indexOf(figure, i + 1)) {
    const before = text[i - 1] ?? '';
    const before2 = text[i - 2] ?? '';
    const after = text[i + figure.length] ?? '';
    const after2 = text[i + figure.length + 1] ?? '';
    const clearBefore = !/[0-9A-Za-z$]/.test(before) && !(/[.,]/.test(before) && /\d/.test(before2));
    const clearAfter = !/[0-9A-Za-z]/.test(after) && !(/[.,]/.test(after) && /\d/.test(after2));
    if (clearBefore && clearAfter) return i;
  }
  return -1;
}

/**
 * A code-written sentence with its figures made clickable: each Num's text is found in order, after
 * the one before, and replaced by make(num); a figure not found stays as text.
 * @template T
 * @param {string} text @param {Num[]} nums @param {(n: Num) => T} make
 * @returns {Array<string | T>}
 */
export function placeNums(text, nums, make) {
  /** @type {Array<string | T>} */
  const out = [];
  let at = 0;
  for (const n of nums) {
    const i = findFigure(text, n.t, at);
    if (i < 0) continue;
    if (i > at) out.push(text.slice(at, i));
    out.push(make(n));
    at = i + n.t.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// The columns the full list sorts by, and the direction each starts in.
export const SORTS = /** @type {const} */ ({ rank: 'ascending', name: 'ascending', total: 'descending', range: 'descending', hours: 'descending', seen: 'descending' });

/**
 * The rows in another order. The rank stays each row's own: sorting moves rows, never renumbers.
 * Ties fall back to the rank.
 * @param {any[]} rows @param {string} key @param {'ascending' | 'descending'} dir
 */
export function sortRows(rows, key, dir) {
  /** @type {Record<string, (r: any) => number | string>} */
  const by = {
    rank: (r) => r.rank,
    name: (r) => String(r.name).toLowerCase(),
    total: (r) => r.total.v,
    range: (r) => r.high.v,
    hours: (r) => r.hours.v,
    seen: (r) => r.occurrences.v,
  };
  const val = by[key] ?? by.rank;
  const sign = dir === 'descending' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = /** @type {any} */ (val(a));
    const y = /** @type {any} */ (val(b));
    return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank;
  });
}

export const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
/** The theme after this one: system, light, dark, then system again. @param {string} t */
export const nextTheme = (t) => THEMES[(THEMES.indexOf(/** @type {any} */ (t)) + 1) % THEMES.length] ?? 'system';

/**
 * The step chart's layout: one step per process in the total, in rank order, the counted part
 * solid under the estimated part; all of it pixel geometry. The x axis labels every rank when a
 * step is 14 px wide or more; narrower, it labels rank 1, every fifth rank and the last, and the
 * caller draws a tick on every step. Direct labels go on the five biggest steps, stacked above the
 * columns they pass over; a label whose box would come within 4 px of the drafting line starts 8 px
 * right of it instead, and the stacking runs on the moved positions.
 * @param {{ width: number, mini?: boolean, steps: Array<{ rank: number, label: string, counted: number, cum: number }>,
 *   yMax: number, drafted: number, measure?: (text: string) => number }} o
 */
export function chartGeometry(o) {
  const mini = o.mini === true;
  const W = Math.max(240, Math.round(o.width || 980));
  const narrow = W < 640;
  const H = mini ? 92 : narrow ? 330 : 470;
  const m = mini ? { l: 4, r: 4, t: 8, b: 16 } : { l: narrow ? 44 : 58, r: narrow ? 60 : 96, t: 18, b: 60 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = o.steps.length;
  const sw = pw / Math.max(1, n);
  const cw = Math.max(2, Math.min(sw * 0.68, 30));
  const yMax = o.yMax > 0 ? o.yMax : 1;
  /** @param {number} c */
  const y = (c) => m.t + ph - (c / yMax) * ph;
  /** @param {number} i */
  const sx = (i) => m.l + i * sw;
  /** @param {number} i */
  const cx = (i) => sx(i) + (sw - cw) / 2;
  const axis = m.t + ph;
  const tx = o.drafted > 0 && o.drafted <= n ? sx(o.drafted) : null;
  const every = sw >= 14;
  /** @type {Array<{ i: number, x: number, text: string }>} */
  const rankLabels = [];
  if (!mini) {
    o.steps.forEach((s, i) => {
      /** @param {number} k */
      const room = (k) => Math.abs(k - i) * sw >= 18;
      const show = every || i === 0 || i === n - 1 || (s.rank % 5 === 0 && room(0) && room(n - 1));
      if (show) rankLabels.push({ i, x: sx(i) + sw / 2, text: String(s.rank) });
    });
  }
  const measure = o.measure ?? ((t) => t.length * 6.7);
  /** @type {Array<{ j: number, x: number, y: number, w: number }>} */
  let labels = [];
  if (!mini && !narrow) {
    for (let count = Math.min(5, n); count > 0; count--) {
      /** @type {Array<{ j: number, x: number, y: number, w: number }>} */
      const out = [];
      let prev = Infinity;
      for (let j = count - 1; j >= 0; j--) {
        const s = /** @type {{ rank: number, label: string, counted: number, cum: number }} */ (o.steps[j]);
        const w = measure(s.label) + 8;
        let x0 = sx(j) + sw / 2 + 5;
        if (tx !== null && x0 - 4 <= tx && tx <= x0 + w + 4) x0 = tx + 8;
        const last = Math.min(n - 1, Math.max(j, Math.floor((x0 + w - m.l) / sw)));
        let top = 0;
        for (let q = j; q <= last; q++) top = Math.max(top, o.steps[q]?.cum ?? 0);
        const yy = Math.min(prev - 18, y(top) - 9);
        out.unshift({ j, x: x0, y: yy, w });
        prev = yy;
      }
      if ((out[0]?.y ?? 0) >= m.t + 12) {
        labels = out;
        break;
      }
    }
  }
  return { W, H, m, pw, ph, n, sw, cw, y, sx, cx, axis, tx, narrow, mini, every, rankLabels, labels, rankY: axis + 13, bracketY: axis + 20, captionY: axis + 33 };
}

// Words for what a click opens, read out with each figure.
/** @type {Record<string, string>} */
export const OPENS = {
  total: 'what the total is made of',
  process: 'the process',
  formula: 'how this figure is worked out',
  actions: 'the messages counted',
  occurrences: 'every time it was seen',
  evidence: 'the quotes behind it',
  participants: 'the people on the threads',
  stalls: 'the quotes where it stalls',
  claims: 'who is named as owner',
  gaps: 'the replies measured',
  loops: 'the open loops',
  months: 'the months it was seen',
  document: 'the drafted document',
  documents: 'the drafted documents',
  message: 'the message',
  thread: 'the thread',
  coverage: 'the messages in this group',
  mailbox: 'where this comes from',
  rows: 'the processes it counts',
  method: 'how we measured',
};

/** @type {Record<string, string>} */
const KIND_WORDS = { counted: 'counted from the emails', estimated: 'estimated from the emails', total: '' };

/** Whether two drill targets open the same place: the same kind and the same parameters.
 * @param {Target} a @param {Target} b */
export function sameTarget(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (/** @type {Record<string, unknown>} */ (a)[k] !== /** @type {Record<string, unknown>} */ (b)[k]) return false;
  return true;
}

/** What a figure's button reads aloud: the figure, its kind, its exact value and what it opens.
 * @param {Num} n @param {string} shown */
export function numLabel(n, shown) {
  const kind = n.k ? KIND_WORDS[n.k] ?? '' : '';
  const exact = n.x && n.x !== shown && !shown.includes(n.x) ? `, exactly ${n.x}` : '';
  return `${shown}${kind ? `, ${kind}` : ''}${exact}. Opens ${OPENS[n.d.kind] ?? 'more'}.`;
}

// The file a process's data is in: its key, or "p-" and the key for a name Windows reserves or a
// folder name the pipeline uses (the build's artifactSlug rule).
const PREFIXED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|input|raw|validated)$/;
/** @param {string} key */
export const processFile = (key) => `process/${PREFIXED.test(key) ? `p-${key}` : key}.json`;

/** @type {Record<string, string>} */
export const DOC_TITLE = { sop: 'SOP', checklist: 'Checklist', email_template: 'Email template', template: 'Template' };

/** @type {Record<string, string>} */
const ACTION_TITLE = {
  authored_short: 'Short emails written',
  authored_medium: 'Medium emails written',
  authored_long: 'Long emails written',
  forward: 'Forwards',
  chaser: 'Chasers',
  read: 'Reads, one per staff addressee',
  authored: 'Emails written',
};
const ACTION_ORDER = ['authored_short', 'authored_medium', 'authored_long', 'forward', 'chaser', 'read'];
/** @type {Record<string, string>} */
const ACTION_RATE_WORDS = {
  authored_short: 'Short email written',
  authored_medium: 'Medium email written',
  authored_long: 'Long email written',
  forward: 'Forward',
  chaser: 'Chaser',
  read: 'Read, per staff addressee',
};
/** @type {Record<string, string>} */
const SEGMENT_WORDS = { quoted: 'inside quoted text', forwarded: 'inside forwarded text' };
/** @type {Record<string, string>} */
export const BUCKET_TITLE = {
  counted: 'Counted under a recurring process',
  unassigned: 'Fit no recurring process',
  personal: 'Personal mail',
  noise: 'Noise',
  automated: 'Sent by systems',
  flagged: 'Flagged',
  duplicates: 'Duplicates',
};
/** @type {Record<string, string>} */
export const ROWS_TITLE = {
  all: 'Every process, ranked',
  in_total: 'The processes in the total',
  below: 'Seen too rarely to count, not in the total',
  one_mailbox: 'Processes 90% or more from one mailbox',
  drafted: 'The processes with a drafted document',
  drafted_one_mailbox: 'Drafted processes that come almost only from one mailbox',
};
/** @param {any} r */
const isDrafted = (r) => r.document !== null && r.document.status === 'done';
/** Which rows a rows target lists, by its filter. @type {Record<string, (r: any) => boolean>} */
export const ROW_KEEP = {
  all: () => true,
  in_total: (r) => r.in_total,
  below: (r) => !r.in_total,
  one_mailbox: (r) => r.in_total && r.one_mailbox,
  drafted: (r) => isDrafted(r),
  drafted_one_mailbox: (r) => isDrafted(r) && r.one_mailbox,
};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** @type {any} */
let D = null; // data.json
/** @type {Map<string, any>} */
const ROWS = new Map();
/** @type {Map<string, any>} */
const MAILBOX = new Map();
/** @type {Map<string, any>} */
const CUM = new Map();
/** @type {Map<string, Promise<any>>} */
const loaded = new Map();
/** @type {Map<string, any> | null} */
let indexMap = null;

/** A JSON file of the dashboard, fetched once; a failure is forgotten so a retry fetches again.
 * @param {string} path @returns {Promise<any>} */
function loadJSON(path) {
  let p = loaded.get(path);
  if (p === undefined) {
    p = fetch(path).then((res) => {
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      return res.json();
    });
    p.catch(() => loaded.delete(path));
    loaded.set(path, p);
  }
  return p;
}
/** @param {string} key */
const loadProcess = (key) => loadJSON(processFile(key));
const loadMethod = () => loadJSON('method.json');
const loadLoops = () => loadJSON('loops.json');
/** The message index as an array (the viewer keeps its own map of it). */
const loadIndexArray = () => loadJSON('messages/index.json');
/** The message index by id. @returns {Promise<Map<string, any>>} */
async function loadIndex() {
  const rows = await loadIndexArray();
  if (indexMap === null) indexMap = new Map(rows.map((/** @type {any} */ r) => [r.id, r]));
  return indexMap;
}

/** @param {string} key */
const rowOf = (key) => ROWS.get(key);
const inTotal = () => D.rows.filter((/** @type {any} */ r) => r.in_total);
const draftedRows = () => D.rows.filter((/** @type {any} */ r) => r.in_total && r.document !== null && r.document.status === 'done');
/** @param {string} key */
const ownerOf = (key) => MAILBOX.get(key)?.owner ?? key;
/** @param {string} key */
const nameOf = (key) => ROWS.get(key)?.name ?? key;

// ---------------------------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';
/** An SVG element: attributes as given (never a style or a handler), children as text or nodes.
 * @param {string} tag @param {Record<string, unknown> | null} attrs @param {Kid[]} kids @returns {SVGElement} */
function sv(tag, attrs, ...kids) {
  const n = /** @type {SVGElement} */ (document.createElementNS(SVGNS, tag));
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' || k.startsWith('on')) throw new TypeError(`sv: ${k} is not set as an attribute`);
    n.setAttribute(k, String(v));
  }
  return add(n, kids);
}

/** @param {string} sel @returns {HTMLElement} */
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

/**
 * A clickable figure: a button that shows the Num's text (or its exact text), reads out its kind,
 * and opens its target. Inside the layer or section its target opens (o.here), it is plain text:
 * no button opens the place it is already in.
 * @param {Num} n
 * @param {{ exact?: boolean, before?: string, after?: string, cls?: string, label?: string, ctx?: Ctx, open?: () => void, here?: Target }} [o]
 */
function num(n, o = {}) {
  const shown = `${o.before ?? ''}${o.exact ? (n.x ?? n.t) : n.t}${o.after ?? ''}`;
  if (o.here !== undefined && sameTarget(n.d, o.here)) return el('span', { class: `fig${o.cls ? ` ${o.cls}` : ''}` }, shown);
  return el('button', {
    type: 'button',
    class: `num${n.k ? ` k-${n.k}` : ''}${o.cls ? ` ${o.cls}` : ''}`,
    'aria-label': o.label ?? numLabel(n, shown),
    onclick: (/** @type {MouseEvent} */ ev) => {
      ev.stopPropagation();
      remember(/** @type {HTMLElement} */ (ev.currentTarget));
      if (o.open) o.open();
      else openTarget(n.d, o.ctx);
    },
  }, shown);
}

/** A count that is not a Num of the data (a list's own length), opening the list it counts.
 * @param {string} text @param {Target} d @param {string} [label] @param {Ctx} [ctx] */
function countBtn(text, d, label, ctx) {
  return num({ v: 0, t: text, d }, { label: label ?? `${text}. Opens ${OPENS[d.kind] ?? 'more'}.`, ctx });
}

/** A text button styled as a link. @param {string} text @param {() => void} go @param {string} [cls] */
function link(text, go, cls = 'link') {
  return el('button', {
    type: 'button',
    class: cls,
    onclick: (/** @type {MouseEvent} */ ev) => {
      ev.stopPropagation();
      remember(/** @type {HTMLElement} */ (ev.currentTarget));
      go();
    },
  }, text);
}

/** A link that opens a target. @param {string} text @param {Target} d @param {Ctx} [ctx] @param {string} [cls] */
const linkTo = (text, d, ctx, cls) => link(text, () => openTarget(d, ctx), cls);

/** The legend swatches: counted solid, estimated hatched, the range a band, the drafting line dashed.
 * @param {'counted' | 'estimated' | 'band' | 'line'} kind */
function swatch(kind) {
  const cls = { counted: 'sw-c', estimated: 'sw-e', band: 'sw-b', line: 'sw-l' }[kind];
  return el('span', { class: `sw ${cls}`, 'aria-hidden': 'true' });
}

/** A sentence from the data with its figures as buttons. @param {string} text @param {Num[]} nums @param {Ctx} [ctx] */
const withNums = (text, nums, ctx) => placeNums(text, nums.filter(Boolean), (n) => num(n, { ctx }));

/** A drawer layer's kicker and title (the dialog's label). @param {string} kicker @param {Kid} title @param {boolean} [mono] */
function head(kicker, title, mono = false) {
  return [el('p', { class: 'layer-kicker' }, kicker), el('h2', { class: `layer-title${mono ? ' mono' : ''}`, id: 'drawer-title' }, title)];
}

/** @param {string} label @param {Kid[]} kids */
function specRow(label, ...kids) {
  return el('section', { class: 'spec-row' }, el('h3', null, label), el('div', { class: 'spec-body' }, kids));
}

/**
 * A part of a layer that waits for a file: "Loading" until it arrives, then what build(value)
 * makes; a failure says what did not load and how to get it back.
 * @template T @param {Promise<T>} promise @param {(v: T) => Kid[]} build @param {string} [what]
 */
function deferred(promise, build, what = 'this part') {
  const box = el('div', { class: 'deferred' }, el('p', { class: 'loading', role: 'status' }, 'Loading…'));
  promise
    .then((v) => {
      box.replaceChildren();
      add(box, build(v));
      if (box.isConnected) afterRender(box);
    })
    .catch((err) => {
      box.replaceChildren(el('p', { class: 'note' }, `${cap(what)} did not load (${err instanceof Error ? err.message : String(err)}). Reload the page; if it still fails, run node obs.mjs build and then node obs.mjs serve.`));
    });
  return box;
}

/** A quote as the page shows it: sender and date first, the message path on the same line, the
 * quoted words opening the message with the span marked. @param {any} q @param {Ctx} [ctx] */
function quoteBlock(q, ctx = {}) {
  const where = SEGMENT_WORDS[q.segment] ?? (q.field === 'subject' ? 'in the subject line' : '');
  return el('figure', { class: 'quote' },
    el('figcaption', { class: 'q-cite' },
      el('span', { class: 'q-who' }, q.sender_label),
      el('span', { class: 'q-when' }, dateText(q.date_utc)),
      where ? el('span', { class: 'q-seg' }, where) : null,
      pathLine(q.message_id)),
    el('button', {
      type: 'button',
      class: 'q-text',
      onclick: (/** @type {MouseEvent} */ ev) => {
        remember(/** @type {HTMLElement} */ (ev.currentTarget));
        openTarget({ kind: 'message', id: q.message_id, quote: q.id }, { ...ctx, quote: q });
      },
    }, `“${q.raw_text}”`, el('span', { class: 'q-open' }, 'Open the message')));
}

/** One message in a list: date, subject (opening it), sender, a note, and its path line.
 * @param {any} row the index row @param {string} id @param {{ note?: string, ctx?: Ctx, d?: Target, mark?: boolean }} [o] */
function msgItem(row, id, o = {}) {
  const d = o.d ?? { kind: 'message', id };
  return el('li', null, el('div', { class: `mitem${o.mark ? ' is-mark' : ''}` },
    el('div', { class: 'mitem-d' }, row ? (row.date_status === 'usable' ? dateText(row.date_utc) : 'no usable date') : ''),
    el('div', null,
      link(row ? (row.subject || '(no subject)') : id, () => openTarget(d, o.ctx), 'mitem-s'),
      el('div', { class: 'mitem-m' }, row ? personName(row.from_name, row.from) : '', o.note ? ` · ${o.note}` : ''),
      pathLine(id))));
}

/**
 * A long list shown a hundred at a time: the first page, then "Show the next 100".
 * @template T @param {T[]} items @param {(item: T) => Node} make @param {number} [size]
 */
function paged(items, make, size = 100) {
  const list = el('ul', { class: 'mlist' });
  const status = el('span', null);
  const more = el('button', { type: 'button', class: 'toggle' }, '');
  const pager = el('p', { class: 'pager' }, status, more);
  let shown = 0;
  const step = () => {
    const next = items.slice(shown, shown + size);
    add(list, next.map(make));
    shown += next.length;
    status.textContent = `Showing ${grouped(shown)} of ${grouped(items.length)}.`;
    const left = items.length - shown;
    more.hidden = left <= 0;
    more.textContent = `Show the next ${grouped(Math.min(size, left))}`;
  };
  more.addEventListener('click', step);
  step();
  return [list, items.length > size ? pager : null];
}

// ---------------------------------------------------------------------------------------------
// The step chart
// ---------------------------------------------------------------------------------------------

let hotKey = /** @type {string | null} */ (null);
let selKey = /** @type {string | null} */ (null);
let showRange = false;
/** @type {Array<{ host: HTMLElement, mini: boolean }>} */
const charts = [];

/** The steps of the chart, from the rows in the total in rank order and the running total.
 * @returns {Array<{ rank: number, key: string, label: string, counted: number, cum: number, low: number, high: number, row: any }>} */
function chartSteps() {
  return inTotal().map((/** @type {any} */ r) => {
    const c = CUM.get(r.key);
    return { rank: r.rank, key: r.key, label: `${r.name}  ${r.total.t}`, counted: r.counted.v, cum: c ? c.cents.v : 0, low: c ? c.low_cents : 0, high: c ? c.high_cents : 0, row: r };
  });
}

/** The words a step reads out and its tip says about where it stalls. @param {any} r */
const stallWords = (r) => (r.stall_summary === null && r.stall_quotes.v === 0 ? 'no stall quoted' : `stalls on: ${r.stall_label}`);

/** Draws the running-total step chart into host: the full chart, or the mini one of a process page.
 * @param {HTMLElement} host @param {boolean} mini */
function pareto(host, mini) {
  const steps = chartSteps();
  if (steps.length === 0) {
    host.replaceChildren(el('p', { class: 'small' }, 'No process is in the total on this run.'));
    return;
  }
  const band = showRange && !mini;
  const yMax = band ? D.chart.y_max_range_cents : D.chart.y_max_cents;
  const yStep = band ? D.chart.y_step_range_cents : D.chart.y_step_cents;
  const axisLabels = band ? D.chart.axis_labels_range : D.chart.axis_labels;
  const svg = sv('svg', { class: mini ? 'pareto mini' : 'pareto', role: 'group' });
  const tip = el('div', { class: 'tip', hidden: true, 'aria-hidden': 'true' });
  host.replaceChildren(svg, tip);
  // Measure the label texts in the page's own font once the chart is on the page.
  const probe = sv('text', { class: 'plab', x: -9999, y: -9999 });
  svg.append(probe);
  /** @param {string} t */
  const measure = (t) => {
    probe.textContent = t;
    const w = /** @type {SVGTextElement} */ (/** @type {unknown} */ (probe)).getComputedTextLength?.() ?? 0;
    return w > 0 ? w : t.length * 6.7;
  };
  const g = chartGeometry({ width: host.clientWidth || 980, mini, steps, yMax, drafted: D.chart.drafted, measure });
  probe.remove();
  const { W, H, m, pw, ph, n, sw, cw, y, sx, cx, axis, tx } = g;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-label', mini
    ? 'Its step in the running total'
    : `Where the ${D.headline.total.t} a month comes from: each process adds its step, biggest first. Use the arrow keys to move between steps.`);

  if (!mini) {
    axisLabels.forEach((/** @type {string} */ text, /** @type {number} */ i) => {
      const v = i * yStep;
      const yy = Math.round(y(v)) + 0.5;
      svg.append(sv('line', { class: i === 0 ? 'base' : 'grid', x1: m.l, x2: m.l + pw, y1: yy, y2: yy }));
      svg.append(sv('text', { class: 'ax', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, text));
    });
  }

  if (band) {
    let top = '';
    let bottom = '';
    let low = '';
    steps.forEach((s, i) => {
      top += `${i === 0 ? 'M' : 'L'}${sx(i)} ${y(s.high)} L${sx(i + 1)} ${y(s.high)} `;
      low += `${i === 0 ? 'M' : 'L'}${sx(i)} ${y(s.low)} L${sx(i + 1)} ${y(s.low)} `;
    });
    for (let i = n - 1; i >= 0; i--) bottom += `L${sx(i + 1)} ${y(steps[i]?.low ?? 0)} L${sx(i)} ${y(steps[i]?.low ?? 0)} `;
    svg.append(sv('path', { class: 'band', d: `${top}${bottom}Z` }), sv('path', { class: 'band-edge', d: top }), sv('path', { class: 'band-edge', d: low }));
  }

  let conn = '';
  steps.forEach((s, i) => {
    if (i < n - 1) conn += `M${cx(i) + cw} ${y(s.cum)} L${cx(i + 1)} ${y(s.cum)} `;
  });
  const last = /** @type {any} */ (steps[n - 1]);
  conn += `M${cx(n - 1) + cw} ${y(last.cum)} L${m.l + pw + (mini ? 0 : 6)} ${y(last.cum)}`;
  svg.append(sv('path', { class: 'conn', d: conn }));

  // The drafting line, and under the axis the bracket of the drafted steps with its caption.
  if (tx !== null) {
    svg.append(sv('line', { class: 'thresh', x1: tx, x2: tx, y1: mini ? m.t - 4 : m.t, y2: mini ? axis : g.bracketY }));
    if (!mini) {
      const by = g.bracketY;
      svg.append(sv('path', { class: 'dbr', d: `M${sx(0) + 1} ${by - 4} V${by} H${tx - 1} V${by - 4}` }));
      svg.append(sv('text', { class: 'dbr-t', x: sx(0) + 1, y: g.captionY }, `Documents drafted for ${draftedRows().length === 1 ? 'this one' : `these ${grouped(draftedRows().length)}`}`));
    }
  }

  /** @param {number} i */
  const showTip = (i) => {
    const s = /** @type {any} */ (steps[i]);
    tip.replaceChildren(el('b', null, s.row.name), ` · ${s.row.total.t} a month · ${stallWords(s.row)}`);
    const x = sx(i) + sw / 2;
    const scale = host.clientWidth ? host.clientWidth / W : 1;
    tip.style.top = `${Math.max(0, (y(s.cum) - 46) * scale)}px`;
    if (x > W * 0.55) {
      tip.style.left = 'auto';
      tip.style.right = `${Math.round((W - x + 12) * scale)}px`;
    } else {
      tip.style.right = 'auto';
      tip.style.left = `${Math.round((x + 12) * scale)}px`;
    }
    tip.hidden = false;
  };
  const hideTip = () => {
    tip.hidden = true;
  };

  if (!mini && !g.every) {
    steps.forEach((_s, i) => svg.append(sv('line', { class: 'ax-tick', x1: sx(i) + sw / 2, x2: sx(i) + sw / 2, y1: axis, y2: axis + 3 })));
  }
  for (const lab of g.rankLabels) svg.append(sv('text', { class: 'ax-rank', x: lab.x, y: g.rankY, 'text-anchor': 'middle', 'aria-hidden': 'true' }, lab.text));

  const focusIndex = Math.max(0, steps.findIndex((s) => s.key === selKey));
  steps.forEach((s, i) => {
    const r = s.row;
    const prev = i === 0 ? 0 : (steps[i - 1]?.cum ?? 0);
    const gEl = sv('g', {
      class: `step${r.key === selKey ? ' is-sel' : ''}${r.key === hotKey ? ' is-hot' : ''}`,
      'data-k': r.key,
      tabindex: mini ? null : i === focusIndex ? 0 : -1,
      role: mini ? null : 'button',
      'aria-label': mini ? null : `Rank ${r.rank}, ${r.name}: ${r.total.t} a month; ${stallWords(r)}. Opens the process.`,
    });
    gEl.append(sv('rect', { class: 'hit', x: sx(i), y: m.t - (mini ? 8 : 0), width: sw, height: ph + (mini ? 8 : 0) }));
    const yc = y(prev + s.counted);
    gEl.append(sv('rect', { class: 'col-c', x: cx(i), y: yc, width: cw, height: Math.max(0, y(prev) - yc) }));
    gEl.append(sv('rect', { class: 'col-e', fill: 'url(#hatch)', x: cx(i), y: y(s.cum), width: cw, height: Math.max(0, yc - y(s.cum)) }));
    if (r.key === selKey && !mini) gEl.append(sv('path', { class: 'selmark', d: `M${sx(i) + sw / 2} ${axis + 2} l-4 7 h8 z` }));
    if (!mini) {
      gEl.addEventListener('mouseenter', () => {
        setHot(r.key);
        showTip(i);
      });
      gEl.addEventListener('mouseleave', () => {
        setHot(null);
        hideTip();
      });
      gEl.addEventListener('focus', () => {
        setHot(r.key);
        showTip(i);
      });
      gEl.addEventListener('blur', () => {
        setHot(null);
        hideTip();
      });
      gEl.addEventListener('keydown', (ev) => {
        const e = /** @type {KeyboardEvent} */ (ev);
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          remember(/** @type {HTMLElement} */ (/** @type {unknown} */ (gEl)));
          openTarget({ kind: 'process', key: r.key });
          return;
        }
        const moves = /** @type {Record<string, number>} */ ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 });
        if (e.key in moves) {
          e.preventDefault();
          const all = [...svg.querySelectorAll('.step')];
          const j = Math.max(0, Math.min(all.length - 1, /** @type {number} */ (moves[e.key])));
          all.forEach((st, k) => st.setAttribute('tabindex', k === j ? '0' : '-1'));
          /** @type {HTMLElement} */ (/** @type {unknown} */ (all[j])).focus();
        }
      });
    }
    gEl.addEventListener('click', () => {
      if (mini) switchProcess(r.key);
      else {
        remember(/** @type {HTMLElement} */ (/** @type {unknown} */ (gEl)));
        openTarget({ kind: 'process', key: r.key });
      }
    });
    svg.append(gEl);
  });

  // Direct labels on the biggest steps, above everything so pointing at one reads its own process.
  for (const L of g.labels) {
    const s = /** @type {any} */ (steps[L.j]);
    const c = sx(L.j) + sw / 2;
    const lg = sv('g', { class: `plabg${s.key === hotKey ? ' is-hot' : ''}`, 'data-k': s.key, 'aria-hidden': 'true' });
    const elbow = L.x - c > 9 ? ` H${L.x - 3}` : '';
    lg.append(sv('path', { class: 'lead', d: `M${c} ${y(s.cum) - 3} V${L.y - 4}${elbow}` }));
    lg.append(sv('text', { class: 'plab', x: L.x, y: L.y }, `${s.row.name}  `, sv('tspan', { class: 'plab-v' }, s.row.total.t)));
    lg.addEventListener('mouseenter', () => {
      setHot(s.key);
      showTip(L.j);
    });
    lg.addEventListener('mouseleave', () => {
      setHot(null);
      hideTip();
    });
    lg.addEventListener('click', () => openTarget({ kind: 'process', key: s.key }));
    svg.append(lg);
  }

  if (!mini) {
    const ex = m.l + pw + 10;
    /** @param {string} cls @param {number} yy @param {string} main @param {string | null} sub @param {string} label */
    const endLab = (cls, yy, main, sub, label) => {
      const e = sv('g', { class: 'endlab', tabindex: 0, role: 'button', 'aria-label': label });
      e.append(sv('text', { class: cls, x: ex, y: yy }, main));
      if (sub) e.append(sv('text', { class: 'end-sub', x: ex, y: yy + 14 }, sub));
      const go = () => {
        remember(/** @type {HTMLElement} */ (/** @type {unknown} */ (e)));
        openTarget(band ? { kind: 'method', section: 'explainer' } : D.headline.total.d);
      };
      e.addEventListener('click', go);
      e.addEventListener('keydown', (ev) => {
        const k = /** @type {KeyboardEvent} */ (ev).key;
        if (k === 'Enter' || k === ' ') {
          ev.preventDefault();
          go();
        }
      });
      svg.append(e);
    };
    endLab(g.narrow ? 'end-main end-n' : 'end-main', y(last.cum) + 6, D.headline.total.t, g.narrow ? null : 'a month', `The total, ${D.headline.total.t} a month. Opens what it is made of.`);
    if (band) {
      endLab('end-alt', y(last.high) + 4, D.headline.high.t, g.narrow ? null : 'high end', `High end of the range, ${D.headline.high.t} a month. Opens how to read these numbers.`);
      endLab('end-alt', y(last.low) + 4, D.headline.low.t, g.narrow ? null : 'low end', `Low end of the range, ${D.headline.low.t} a month. Opens how to read these numbers.`);
    }
  }
}

function drawCharts() {
  for (let i = charts.length - 1; i >= 0; i--) {
    const c = charts[i];
    if (c === undefined) continue;
    if (!c.host.isConnected) charts.splice(i, 1);
    else if (c.host.offsetParent !== null) pareto(c.host, c.mini);
  }
}

/** @param {string | null} k */
function setHot(k) {
  hotKey = k;
  document.querySelectorAll('.is-hot').forEach((x) => x.classList.remove('is-hot'));
  if (k) document.querySelectorAll(`[data-k="${CSS.escape(k)}"]`).forEach((x) => x.classList.add('is-hot'));
}

/** @param {string | null} k */
function setSel(k) {
  if (k === selKey) return;
  selKey = k;
  document.querySelectorAll('tr.is-sel').forEach((x) => x.classList.remove('is-sel'));
  if (k) document.querySelectorAll('tr.row').forEach((x) => x.getAttribute('data-k') === k && x.classList.add('is-sel'));
  drawCharts();
}

/** @param {boolean} on */
function setRange(on) {
  showRange = on;
  document.querySelectorAll('.rangebtn').forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(swatch('band'), on ? 'Hide the range' : 'Show the range');
  });
  drawCharts();
}

// ---------------------------------------------------------------------------------------------
// The drawer: one stack of layers, with Back and a breadcrumb
// ---------------------------------------------------------------------------------------------

/** @type {Layer[]} */
const stack = [];
/** The page element the drawer was opened from, so closing it puts the focus back. @type {HTMLElement | null} */
let opener = null;
/** The element inside the drawer that opened the layer about to go on top. @type {HTMLElement | null} */
let innerOpener = null;
/** The layer whose nodes are in the drawer's body. @type {Layer | null} */
let shown = null;
// When the drawer last opened and last changed layer, for the double-click guards.
let openedAt = -1e9;
let renderedAt = -1e9;
const drawer = () => $('#drawer');
const isOpen = () => !drawer().hidden;

/** The element a click came from: on the page, the drawer's opener; inside it, the layer's. @param {HTMLElement | null} node */
function remember(node) {
  if (node === null) return;
  if (drawer().contains(node)) innerOpener = node;
  else opener = node;
}

/** Whether two layers show the same thing (a second click on the same figure). @param {Layer | undefined} a @param {Layer} b */
const sameLayer = (a, b) => a !== undefined && a.crumb === b.crumb && a.key === b.key;

/** @param {Layer[]} layers */
function openRoot(...layers) {
  stack.length = 0;
  stack.push(...layers);
  showDrawer();
}
/** A layer on top of the stack; the layer below keeps its nodes, its scroll and the element that opened it.
 * @param {Layer} layer */
function push(layer) {
  const top = stack[stack.length - 1];
  if (sameLayer(top, layer)) return;
  if (top !== undefined) top.from = innerOpener !== null && drawer().contains(innerOpener) ? innerOpener : null;
  stack.push(layer);
  showDrawer();
}
/** The top layer swapped for another; the layer below keeps the element that opened the top one.
 * @param {Layer} layer */
function replaceTop(layer) {
  if (stack.length === 0) return openRoot(layer);
  stack[stack.length - 1] = layer;
  renderDrawer(false);
}
/** A layer on top of the drawer, or the drawer opened on it. @param {Layer} layer */
const show = (layer) => (isOpen() ? push(layer) : openRoot(layer));

/** The page behind the drawer, out of reach while it is open. @param {boolean} on */
function setInert(on) {
  for (const sel of ['.brandrule', '.shell']) {
    const n = document.querySelector(sel);
    if (n instanceof HTMLElement) n.inert = on;
  }
}

function showDrawer() {
  if (drawer().hidden) openedAt = performance.now();
  drawer().hidden = false;
  $('#scrim').hidden = false;
  document.body.classList.add('is-locked');
  setInert(true);
  renderDrawer(false);
}

/**
 * Shows the layer on top of the stack. A layer seen before comes back as it was left (its nodes,
 * its scroll), with the focus on the element that opened the layer just left; a new one is
 * rendered, with the focus on its title.
 * @param {boolean} returning
 */
function renderDrawer(returning) {
  const layer = /** @type {Layer} */ (stack[stack.length - 1]);
  /** @type {Kid[]} */
  const crumbs = [el('button', { type: 'button', onclick: closeDrawer }, viewName())];
  stack.forEach((l, i) => {
    crumbs.push(el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'));
    if (i === stack.length - 1) crumbs.push(el('span', { class: 'here', 'aria-current': 'page', title: l.crumb }, l.crumb));
    else {
      crumbs.push(el('button', {
        type: 'button',
        title: l.crumb,
        onclick: () => {
          stack.length = i + 1;
          renderDrawer(true);
        },
      }, l.crumb));
    }
  });
  const nav = $('#crumbs');
  nav.replaceChildren();
  add(nav, crumbs);
  const body = $('#d-body');
  if (shown !== null && shown !== layer) {
    shown.nodes = [...body.childNodes];
    shown.scroll = body.scrollTop;
  }
  body.replaceChildren();
  const cached = layer.nodes;
  if (cached !== undefined) body.append(...cached);
  else add(body, layer.render());
  body.scrollTop = cached !== undefined ? (layer.scroll ?? 0) : 0;
  shown = layer;
  innerOpener = null;
  renderedAt = performance.now();
  if (layer.key) setSel(layer.key);
  afterRender(body);
  const from = returning ? layer.from : null;
  if (from && from.isConnected) {
    from.focus({ preventScroll: true });
    return;
  }
  const t = body.querySelector('#drawer-title');
  if (t instanceof HTMLElement) {
    t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
  }
}

/** Draws the mini charts a layer (or a part that just loaded) brought. @param {Element} root */
function afterRender(root) {
  root.querySelectorAll('.minihost-c').forEach((h) => {
    const host = /** @type {HTMLElement} */ (h);
    if (!charts.some((c) => c.host === host)) charts.push({ host, mini: true });
    pareto(host, true);
  });
}

export function closeDrawer() {
  stack.length = 0;
  shown = null;
  innerOpener = null;
  drawer().hidden = true;
  $('#scrim').hidden = true;
  document.body.classList.remove('is-locked');
  setInert(false);
  $('#d-body').replaceChildren();
  for (let i = charts.length - 1; i >= 0; i--) if (charts[i]?.mini) charts.splice(i, 1);
  if (opener && !opener.isConnected) {
    const k = opener.getAttribute('data-k');
    opener = k ? document.querySelector(`.pareto:not(.mini) .step[data-k="${CSS.escape(k)}"]`) : null;
  }
  if (opener && opener.isConnected) opener.focus();
}

export function back() {
  if (stack.length > 1) {
    stack.pop();
    renderDrawer(true);
  } else closeDrawer();
}

function viewName() {
  return { 'open-loops': 'Open loops', methodology: 'How we measured', 'all-processes': 'All processes' }[currentView()] ?? 'Overview';
}

/** In a process page, the mini chart switches to another process in place. @param {string} key */
function switchProcess(key) {
  stack.length = 0;
  stack.push(processLayer(key));
  renderDrawer(false);
}

// ---------------------------------------------------------------------------------------------
// Targets: what every figure opens
// ---------------------------------------------------------------------------------------------

/**
 * Opens a figure's target. From the page, a target inside a process opens with the process page
 * under it, so Back leads there; inside the drawer it goes on top of the current layer.
 * @param {Target} d @param {Ctx} [ctx]
 */
export function openTarget(d, ctx = {}) {
  if (d.kind === 'method' && d.section !== 'explainer') {
    goMethod(String(d.section));
    return;
  }
  if (d.kind === 'loops' && d.key === undefined && d.drafted !== true) {
    go('open-loops');
    return;
  }
  const layer = layerFor(d, ctx);
  if (layer === null) return;
  const key = d.kind === 'process' || d.kind === 'mailbox' ? undefined : d.key;
  if (isOpen()) push(layer);
  else if (key !== undefined && ROWS.has(key)) openRoot(processLayer(key), layer);
  else openRoot(layer);
}

/** The layer a target opens. @param {Target} d @param {Ctx} ctx @returns {Layer | null} */
function layerFor(d, ctx) {
  const key = String(d.key ?? '');
  switch (d.kind) {
    case 'total':
      return totalLayer();
    case 'process':
      return processLayer(key);
    case 'formula':
      return formulaLayer(key);
    case 'actions':
      return actionsLayer(key, String(d.type), d.person, ctx.counted_in?.by);
    case 'occurrences':
      return occurrencesLayer(key, d.month);
    case 'evidence':
      return evidenceLayer(key, d.set === 'estimate' ? 'estimate' : 'all');
    case 'participants':
      return participantsLayer(key, String(d.filter ?? 'all'));
    case 'stalls':
      return stallsLayer(key, d.stall_kind);
    case 'claims':
      return claimsLayer(key);
    case 'gaps':
      return gapsLayer(key);
    case 'loops':
      return d.key === undefined ? draftedLoopsLayer() : processLoopsLayer(key, d.recent === true);
    case 'months':
      return monthsLayer(key);
    case 'document':
      return documentLayer(key);
    case 'documents':
      return documentsLayer();
    case 'message':
      return messageLayer(String(d.id), { quote: ctx.quote ?? null, action: d.action ?? null, counted_in: ctx.counted_in ?? null });
    case 'thread':
      return threadLayer(String(d.id), ctx.mark);
    case 'coverage':
      return coverageLayer(String(d.bucket));
    case 'mailbox':
      return d.key === undefined ? whereLayer() : mailboxLayer(key);
    case 'rows':
      return rowsLayer(String(d.filter ?? 'all'));
    case 'method':
      return explainerLayer();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Layers: the total, how to read the numbers, where it comes from
// ---------------------------------------------------------------------------------------------

/** @returns {Layer} */
function totalLayer() {
  const H = D.headline;
  return {
    crumb: `${H.total.t} a month`,
    render: () => [
      ...head('The total', `${H.total.t} a month could be automated`),
      el('p', { class: 'plain' },
        el('span', { class: 'big' }, `${H.total.t} a month`), ' = ', H.counted.t, ' of email time counted + ', H.estimated.t, ' of hands-on work estimated. That is ',
        H.hours.t, ' hours a month at ', num(D.rates.hourly), ' an hour, across the ', num(H.rows_in_total, { after: ' processes' }), ' below. ',
        link('How to read these numbers', () => push(explainerLayer()))),
      el('p', { class: 'label' }, 'Exactly'),
      el('div', { class: 'eq' },
        el('div', { class: 'eq-part' }, el('b', null, H.total.x)),
        el('span', { class: 'eq-op' }, '='),
        el('div', { class: 'eq-part' }, swatch('counted'), el('b', null, H.counted.x), el('span', null, 'counted at published minutes')),
        el('span', { class: 'eq-op' }, '+'),
        el('div', { class: 'eq-part' }, swatch('estimated'), el('b', null, H.estimated.x), el('span', null, 'estimated from the emails'))),
      el('div', { class: 'spec' },
        specRow('On the page', el('p', { class: 'calc' }, `${H.counted.t} + ${H.estimated.t} = ${H.total.t}. Whole dollars by largest remainder, so the shown parts add up to the shown total. `, link('How we round', () => goMethod('rounding')))),
        specRow('Hours', el('p', { class: 'calc' }, 'At ', num(D.rates.hourly), ` an hour, ${H.total.x} a month is ${H.hours.x} a month. Today the same work costs ${H.today.x} a month (${H.hours_today.x}).`)),
        specRow('Reading time', el('p', { class: 'calc' }, D.sentences.reading)),
        specRow('Range', el('p', { class: 'calc' }, `${H.low.x} to ${H.high.x} a month, with every work estimate at the low or the high end of its own range. It is not a confidence interval.`)),
        specRow(`The ${H.rows_in_total.t} processes in the total`, el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
          el('thead', null, el('tr', null, th('Rank', 'r'), th('Process'), th('Counted', 'r'), th('Estimated', 'r'), th('Total', 'r'), th('Running total', 'r'))),
          el('tbody', null, inTotal().map((/** @type {any} */ r) => el('tr', null,
            el('td', { class: 'r' }, String(r.rank)),
            el('td', null, link(r.name, () => push(processLayer(r.key)))),
            el('td', { class: 'r' }, num(r.counted, { exact: true })),
            el('td', { class: 'r' }, num(r.estimated, { exact: true })),
            el('td', { class: 'r' }, num(r.total, { exact: true })),
            el('td', { class: 'r' }, CUM.get(r.key)?.cents.x ?? '')))),
          el('tfoot', null, el('tr', null, el('td'), el('td', null, `${H.rows_in_total.t} processes`),
            el('td', { class: 'r' }, H.counted.x), el('td', { class: 'r' }, H.estimated.x), el('td', { class: 'r' }, H.total.x), el('td'))))))),
    ],
  };
}

/** A table header cell. @param {string} text @param {string} [cls] @param {string} [sub] */
function th(text, cls, sub) {
  return el('th', { class: cls ?? null, scope: 'col' }, text, sub ? el('span', { class: 'th-sub' }, sub) : null);
}

/** @returns {Layer} */
function explainerLayer() {
  const H = D.headline;
  const S = D.sentences;
  const R = D.rates;
  const mins = R.minutes;
  return {
    crumb: 'How to read these numbers',
    render: () => [
      ...head('How to read these numbers', `What the ${H.total.t} a month is`),
      el('p', { class: 'plain' },
        `It is the part of the recurring work in these ${numberWord(D.scope.mailboxes.length)} mailboxes that could be automated, priced at `, num(R.hourly), ' an hour: ',
        num(H.total, { after: ' a month' }), ', or ', num(H.hours, { after: ' hours' }), '. The same work takes ', num(H.today, { after: ' a month' }), ` (${H.hours_today.t} hours) today.`),
      el('div', { class: 'spec' },
        specRow('Counted from the emails',
          el('p', { class: 'calc' }, swatch('counted'), ' ', el('b', null, `${H.counted.t} a month. `),
            `Every email written, forwarded, chased and read, counted message by message and priced at published minutes per action: a short email ${mins.authored_short} minutes, a medium one ${mins.authored_medium}, a long one ${mins.authored_long}, a forward ${mins.forward}, a chaser ${mins.chaser}, and ${plural(mins.read, 'minute')} per staff addressee to read it. Each action has a published share that could be automated. `,
            ...withNums(S.reading, [H.reading])),
          el('p', null, link('The published rates', () => goMethod('rates')))),
        specRow('Estimated from the emails',
          el('p', { class: 'calc' }, swatch('estimated'), ' ', el('b', null, `${H.estimated.t} a month. `),
            'The hands-on work behind each round of a process (checking, looking up, fixing), estimated once per process from the emails it cites: minutes a round, and the share that could be automated. Code checks every estimate: its bounds, its citations, and that it rests on more than one sender.'),
          el('p', null, link('How the estimates are made', () => goMethod('estimates')))),
        specRow('The range',
          el('p', { class: 'calc' }, swatch('band'), ' ', el('b', null, `${H.low.t} to ${H.high.t} a month. `),
            'What the total becomes if every work estimate sat at the low or the high end of its own range. It is not a confidence interval. The counted part does not move.'),
          el('p', null, el('button', {
            type: 'button',
            class: 'btn',
            onclick: () => {
              closeDrawer();
              setRange(true);
              afterView = () => document.getElementById('c-h')?.scrollIntoView({ block: 'start' });
              go('overview');
            },
          }, 'Show the range on the chart'))),
        specRow('Documents',
          el('p', { class: 'calc' }, swatch('line'), ' ', S.threshold, ' ', S.sensitivity),
          el('p', null, link('The drafted documents', () => push(documentsLayer())), ' · ', link('How we chose', () => goMethod('threshold')))),
        specRow('Averaging', el('p', { class: 'calc' }, S.averaging)),
        specRow('Not included',
          el('p', { class: 'calc' }, ...withNums(S.not_included, [H.rows_below, H.below_cents, H.unassigned_messages])),
          el('p', null, link('Every message, accounted for', () => goMethod('coverage')))),
        specRow('Where it comes from',
          el('p', { class: 'calc' }, S.scope, ' ', ...withNums(S.concentration, [H.one_mailbox_rows, H.rows_in_total, H.one_mailbox_cents, H.total])),
          el('p', null, link('See where this comes from', () => push(whereLayer()))))),
    ],
  };
}

/** The timeline every span is drawn on: the first of the scope's first month to the first of the
 * month after its last (pixel geometry only). */
function scopeSpan() {
  const first = String(D.scope.first_utc).slice(0, 7);
  const last = String(D.scope.last_utc).slice(0, 7);
  const d0 = dayNumber(`${first}-01`) ?? 0;
  const d1 = dayNumber(`${nextMonth(last)}-01`) ?? d0 + 1;
  return { d0, d1, first, last, x: (/** @type {number} */ d) => ((d - d0) / Math.max(1, d1 - d0)) * 100 };
}

/** The mailboxes' records as bars on the scope's timeline. */
function spanRows() {
  const span = scopeSpan();
  return D.scope.mailboxes.map((/** @type {any} */ mb) => {
    const a = span.x(dayNumber(mb.first_utc) ?? span.d0);
    const b = span.x(dayNumber(mb.last_utc) ?? span.d1);
    return el('div', { class: 'span-row' },
      el('span', { class: 'span-top' }, el('b', null, mb.owner),
        el('span', null, `${dateText(mb.first_utc)} to ${dateText(mb.last_utc)} · `, num(mb.messages, { after: ' messages' }), mb.received_only ? ', received only' : '')),
      el('span', { class: 'span-track', 'aria-hidden': 'true' },
        el('span', { class: `span-bar${mb.received_only ? ' is-recv' : ''}`, style: { left: `${a.toFixed(2)}%`, width: `${Math.max(0.4, b - a).toFixed(2)}%` } })));
  });
}

/** @returns {Layer} */
function whereLayer() {
  const H = D.headline;
  const mbs = D.scope.mailboxes;
  const ends = [...new Set(mbs.map((/** @type {any} */ m) => m.last_utc))].sort().map((x) => dateText(/** @type {string} */ (x)));
  const owners = mbs.map((/** @type {any} */ m) => `${m.owner}’s`);
  return {
    crumb: 'Where this comes from',
    render: () => [
      ...head('Where this comes from', `${cap(numberWord(mbs.length))} people’s mail`),
      el('p', { class: 'plain' },
        `We read every message in ${numberWord(mbs.length)} ${mbs.length === 1 ? 'mailbox' : 'mailboxes'}: ${owners.length > 1 ? `${owners.slice(0, -1).join(', ')} and ${owners.at(-1)}` : owners[0] ?? ''}, ${dateText(D.scope.first_utc)} to ${dateText(D.scope.last_utc)}. `,
        ...withNums(D.sentences.concentration, [H.one_mailbox_rows, H.rows_in_total, H.one_mailbox_cents, H.total])),
      el('p', { class: 'calc' }, D.sentences.caution),
      el('div', { class: 'spans' }, spanRows()),
      el('div', { class: 'span-axis', 'aria-hidden': 'true' }, el('span', null, monthShort(scopeSpan().first)), el('span', null, monthShort(scopeSpan().last))),
      el('p', { class: 'label' }, 'The mailboxes'),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Mailbox'), th('Messages', 'r'), th('First'), th('Last'), th('Own mail'), th('Processes 90%+ from it', 'r'), th('Their total a month', 'r'))),
        el('tbody', null, mbs.map((/** @type {any} */ mb) => el('tr', null,
          el('td', null, link(mb.owner, () => push(mailboxLayer(mb.key)))),
          el('td', { class: 'r' }, num(mb.messages)),
          el('td', null, dateText(mb.first_utc)),
          el('td', null, dateText(mb.last_utc)),
          el('td', null, mb.received_only ? `received only: ${grouped(mb.own_messages)} sent by ${mb.owner}` : `${grouped(mb.own_messages)} sent by ${mb.owner}`),
          el('td', { class: 'r' }, num(mb.rows_mostly)),
          el('td', { class: 'r' }, num(mb.rows_mostly_cents))))),
        el('tfoot', null, el('tr', null, el('td', null, `All ${numberWord(mbs.length)}`), el('td', { class: 'r' }, num(D.scope.files)), el('td', null, dateText(D.scope.first_utc)), el('td', null, dateText(D.scope.last_utc)), el('td'),
          el('td', { class: 'r' }, num(H.one_mailbox_rows)), el('td', { class: 'r' }, num(H.one_mailbox_cents)))))),
      mbs.filter((/** @type {any} */ m) => m.received_only).map((/** @type {any} */ m) => el('p', { class: 'caution' }, `${m.owner}’s replies are not in this archive. A request with no visible reply may have been answered.`)),
      el('p', { class: 'small' }, `The ${numberWord(mbs.length)} records stop on different days: ${ends.length > 1 ? `${ends.slice(0, -1).join(', ')} and ${ends.at(-1)}` : ends[0] ?? ''}.`),
    ],
  };
}

/** One mailbox: its record, the processes that come almost only from it, and every message in it.
 * @param {string} key @returns {Layer} */
function mailboxLayer(key) {
  const mb = MAILBOX.get(key);
  const rows = D.rows.filter((/** @type {any} */ r) => r.in_total && r.one_mailbox && r.top_mailbox === key);
  return {
    crumb: mb ? mb.owner : key,
    render: () => [
      ...head('Mailbox', mb ? `${mb.owner}’s mailbox` : key),
      mb ? el('p', { class: 'plain' }, `${dateText(mb.first_utc)} to ${dateText(mb.last_utc)}: `, mb.messages.t, ` messages, ${grouped(mb.own_messages)} of them sent by ${mb.owner}.`) : null,
      mb && mb.received_only ? el('p', { class: 'caution' }, `${mb.owner}’s replies are not in this archive. A request with no visible reply may have been answered.`) : null,
      el('p', { class: 'label' }, mb ? `${mb.rows_mostly.t} processes in the total come 90% or more from it, worth ${mb.rows_mostly_cents.t} a month` : 'Processes'),
      rowList(rows),
      el('p', { class: 'label' }, mb ? `Its ${mb.messages.t} messages` : 'Its messages'),
      deferred(loadIndexArray(), (ix) => paged(ix.filter((/** @type {any} */ r) => r.mailbox === key), (r) => msgItem(r, r.id)), 'the message list'),
    ],
  };
}

/** Processes as a list: rank, name (opening the process), dollars and where they are seen. @param {any[]} rows */
function rowList(rows) {
  if (rows.length === 0) return el('p', { class: 'small' }, 'None.');
  return el('ul', { class: 'mlist' }, rows.map((r) => el('li', null, el('div', { class: 'mitem' },
    el('div', { class: 'mitem-d' }, `Rank ${r.rank}`),
    el('div', null, link(r.name, () => openTarget({ kind: 'process', key: r.key }), 'mitem-s'),
      el('div', { class: 'mitem-m' }, num(r.total, { after: ' a month' }), ` · ${r.in_total ? r.seen_in : `${cap(r.tier_words)} · ${r.seen_in}`}`))))));
}

/** @param {string} filter @returns {Layer} */
function rowsLayer(filter) {
  const rows = D.rows.filter(ROW_KEEP[filter] ?? ROW_KEEP.all);
  return {
    crumb: `${ROWS_TITLE[filter] ?? 'Processes'}: ${rows.length}`,
    render: () => [
      ...head('Processes', `${ROWS_TITLE[filter] ?? 'Processes'}: ${grouped(rows.length)}`),
      filter === 'below' && rows.length > 0 ? el('p', { class: 'calc' }, `${cap(rows[0].tier_words)}; each is listed after the total.`) : null,
      rowList(rows),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The process page
// ---------------------------------------------------------------------------------------------

/** @param {any} r */
function processKicker(r) {
  return `Rank ${r.rank} of ${grouped(D.rows.length)} · ${r.in_total ? '' : `${r.tier_words} · `}${r.seen_in}`;
}

/** The value, the chain and the ways down, from the row alone. @param {any} r */
function processLead(r) {
  return [
    el('p', { class: 'plain' },
      num(r.total, { after: ' a month', cls: 'big' }), ' = ', num(r.counted), ' of email time counted',
      r.estimate === null ? '; no estimate of the hands-on work passed the checks.' : [' + ', num(r.estimated), ' of hands-on work estimated']),
    el('p', { class: 'calc' }, 'That is ', num(r.hours, { after: ' hours a month' }),
      r.estimate === null ? '.' : ['. The estimates put it between ', num(r.low), ' and ', num(r.high), '.']),
    el('div', { class: 'chain' },
      el('p', null, el('b', null, 'Where it stalls: '), stallLine(r)),
      el('p', null, el('b', null, 'What would fix it: '), r.fix === null ? 'no approach was proposed.' : [r.fix, ' ', el('span', { class: 'ours' }, '(our proposal)')]),
      el('p', null, el('b', null, 'Ready to use: '), docLine(r))),
    el('div', { class: 'deeper' },
      link('See the formula', () => push(formulaLayer(r.key)), 'btn-ghost'),
      r.estimate === null ? null : link('Read the emails behind the estimate', () => push(evidenceLayer(r.key, 'estimate')), 'btn-ghost'),
      link('Every time it was seen', () => push(occurrencesLayer(r.key)), 'btn-ghost')),
  ];
}

/** Where a process stalls, in a line: the most-cited summary, else the count of its stall quotes.
 * @param {any} r @returns {Kid} */
function stallLine(r) {
  if (r.stall_summary !== null) return r.stall_summary;
  if (r.stall_quotes.v > 0) return [num(r.stall_quotes), ` were found (${r.stall_label}); no summary was written.`];
  return 'no stall was quoted for this process.';
}

/** The document, opening it and its blanks; or why there is none. @param {any} r @returns {Kid} */
function docLine(r) {
  const doc = r.document;
  if (doc !== null && doc.status === 'done') {
    return [linkTo(DOC_TITLE[doc.type] ?? doc.type, { kind: 'document', key: r.key }), doc.blanks ? [', ', num(doc.blanks, { after: ' to confirm' })] : null];
  }
  return r.status_line;
}

/** @param {string} key @returns {Layer} */
function processLayer(key) {
  const r = rowOf(key);
  if (r === undefined) return { crumb: key, render: () => [...head('Process', key), el('p', { class: 'note' }, 'No process with this key in the data.')] };
  return {
    crumb: r.name,
    key,
    render: () => [
      ...head(processKicker(r), r.name),
      ...processLead(r),
      r.in_total ? miniChart() : null,
      el('p', { class: 'label' }, 'The details'),
      deferred(loadProcess(key), (f) => processDetails(r, f), 'the process data'),
    ],
  };
}

function miniChart() {
  return el('div', { class: 'minihost' },
    el('div', { class: 'minicap' }, el('span', null, 'Its step in the running total'), el('span', null, 'Select another step to switch')),
    el('div', { class: 'minihost-c' }));
}

/** Every section of a process page that needs its file. @param {any} r @param {any} f */
export function processDetails(r, f) {
  return [el('div', { class: 'spec' },
    summaryRow(f),
    howOftenRow(r, f),
    peopleRow(r, f),
    stallsRow(r, f),
    ownerRow(r, f),
    loopsRow(r, f),
    proposalRow(r, f),
    numbersRow(r, f))];
}

/** @param {any} f */
function summaryRow(f) {
  const s = f.synthesis;
  if (s === null) {
    return specRow('Summary', el('p', { class: 'tag' }, 'No summary was written for this process. Its definition, as the run set it:'), el('p', { class: 'prose' }, f.definition));
  }
  return specRow('Summary',
    el('p', { class: 'tag' }, 'A summary, written by the run from the cited emails.'),
    el('p', { class: 'prose' }, s.description),
    el('p', { class: 'sub-h' }, 'The steps, as the emails show them'),
    el('ol', { class: 'steps' }, s.steps.map((/** @type {string} */ x) => el('li', null, x))));
}

/** "Seen 61 times over 232 days (8 active months), 12 Jun 2001 to 29 Jan 2002, in 71 emails." with
 * its counts as buttons, except those that open the layer it is shown in (here).
 * @param {any} r @param {Target} [here] */
function seenLine(r, here) {
  if (r.first_utc === null || r.last_utc === null) return ['Seen ', num(r.occurrences, { here }), ', with no usable date, in ', num(r.messages, { here }), '.'];
  return ['Seen ', num(r.occurrences, { here }), ` over ${plural(r.span_days, 'day')} (`, num(r.active_months, { here }), `), ${dateText(r.first_utc)} to ${dateText(r.last_utc)}, in `, num(r.messages, { here }), '.'];
}

/** @param {any} r @param {any} f */
function howOftenRow(r, f) {
  const top = MAILBOX.get(r.top_mailbox);
  return specRow('How often',
    el('p', null, seenLine(r)),
    monthStrip(r, f),
    el('p', { class: 'small' }, 'Bars: rounds seen each month; select one to list them. Lines: each mailbox’s record, the darker one where most of its emails are. Emails by mailbox: ',
      r.mailboxes.map((/** @type {any} */ m) => `${ownerOf(m.key)} ${grouped(m.n)} (${m.pct}%)`).join(', '), '.'),
    r.last_three_months_share === null ? null : el('p', null, num(r.last_three_months_share), ` rounds fall in the last three months of ${top ? top.owner : r.top_mailbox}’s record.`),
    f.undated_occurrences.length > 0 ? el('p', { class: 'small' }, `${cap(plural(f.undated_occurrences.length, 'round'))} with no usable date ${f.undated_occurrences.length === 1 ? 'is' : 'are'} counted but sit in no month.`) : null);
}

/** Rounds per month as bars on the scope's timeline, each opening that month's rounds, with the
 * mailboxes' records drawn underneath. @param {any} r @param {any} f */
function monthStrip(r, f) {
  const span = scopeSpan();
  const top = Math.max(1, ...f.monthly.map((/** @type {any} */ x) => x.occurrences.v));
  const bars = el('div', { class: 'strip-bars' });
  for (const mo of f.monthly) {
    const a = span.x(dayNumber(`${mo.month}-01`) ?? span.d0);
    const b = span.x(dayNumber(`${nextMonth(mo.month)}-01`) ?? span.d1);
    const h = (mo.occurrences.v / top) * 84;
    bars.append(el('button', {
      type: 'button',
      class: 'mbar',
      style: { left: `calc(${a.toFixed(3)}% + 1px)`, width: `calc(${(b - a).toFixed(3)}% - 2px)`, height: `${h.toFixed(1)}px` },
      'aria-label': `${monthText(mo.month)}: ${mo.occurrences.t} ${mo.occurrences.v === 1 ? 'round' : 'rounds'}. Opens that month’s rounds.`,
      onclick: (/** @type {MouseEvent} */ ev) => {
        remember(/** @type {HTMLElement} */ (ev.currentTarget));
        openTarget(mo.occurrences.d);
      },
    }));
    bars.append(el('span', { class: 'mbar-n', 'aria-hidden': 'true', style: { left: `${((a + b) / 2).toFixed(3)}%`, bottom: `${(h + 2).toFixed(1)}px` } }, mo.occurrences.t));
  }
  const axis = el('div', { class: 'strip-axis', 'aria-hidden': 'true' });
  for (let ym = span.first; ym <= span.last; ym = nextMonth(ym)) {
    if (ym.endsWith('-01') || ym === span.first) {
      const x = span.x(dayNumber(`${ym}-01`) ?? span.d0);
      axis.append(el('i', { style: { left: `${x.toFixed(3)}%` } }), el('span', { style: { left: `calc(${x.toFixed(3)}% + 3px)` } }, ym.endsWith('-01') ? ym.slice(0, 4) : monthShort(ym)));
    }
  }
  const lanes = el('div', { class: 'strip-lanes' }, D.scope.mailboxes.map((/** @type {any} */ mb) => {
    const a = span.x(dayNumber(mb.first_utc) ?? span.d0);
    const b = span.x(dayNumber(mb.last_utc) ?? span.d1);
    return el('div', { class: 'slane' },
      el('div', { class: 'slane-l' }, el('b', null, mb.owner), ` · ${dateText(mb.first_utc)} to ${dateText(mb.last_utc)}`),
      el('div', { class: 'slane-t' }, el('div', { class: `slane-b${mb.key === r.top_mailbox ? ' is-main' : ''}`, style: { left: `${a.toFixed(3)}%`, width: `${Math.max(0.4, b - a).toFixed(3)}%` } })));
  }));
  return el('div', { class: 'strip' }, bars, axis, lanes);
}

/** The people on a process's threads, staff by what they did, the rest apart. @param {any} f */
function peopleOf(f) {
  /** @param {any} x */
  const sent = (x) => x.authored + x.forwards + x.chasers;
  const P = f.participants;
  return {
    writers: P.filter((/** @type {any} */ x) => x.staff && x.wrote).sort((/** @type {any} */ a, /** @type {any} */ b) => sent(b) - sent(a) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    copied: P.filter((/** @type {any} */ x) => x.staff && !x.wrote),
    lists: P.filter((/** @type {any} */ x) => x.kind === 'list'),
    system: P.filter((/** @type {any} */ x) => x.kind === 'system'),
    outside: P.filter((/** @type {any} */ x) => x.kind === 'person' && !x.staff),
  };
}

/** A count in a person's row, opening the messages it counts. @param {string} key @param {any} p @param {string} type @param {number} n */
function personCount(key, p, type, n) {
  if (n === 0) return '0';
  if (!p.staff) return grouped(n);
  return countBtn(grouped(n), { kind: 'actions', key, type, person: p.email }, `${grouped(n)} ${(ACTION_TITLE[type] ?? type).toLowerCase()} by ${p.label}. Opens the messages counted.`, { counted_in: { by: p.label } });
}

/** The table of people with what each wrote, forwarded, chased and read. @param {string} key @param {any[]} people @param {string} first */
function peopleTable(key, people, first) {
  return el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
    el('thead', null, el('tr', null, th(first), th('Written', 'r'), th('Forwarded', 'r'), th('Chasers', 'r'), th('Read', 'r'))),
    el('tbody', null, people.map((p) => el('tr', null,
      el('td', { title: p.addresses.length > 1 ? `Folded addresses: ${p.addresses.join(', ')}` : null }, p.label,
        p.label !== p.email ? el('span', { class: 'addr' }, p.addresses.join(', ')) : null),
      el('td', { class: 'r' }, personCount(key, p, 'authored', p.authored)),
      el('td', { class: 'r' }, personCount(key, p, 'forward', p.forwards)),
      el('td', { class: 'r' }, personCount(key, p, 'chaser', p.chasers)),
      el('td', { class: 'r' }, personCount(key, p, 'read', p.reads)))))));
}

/** @param {any} r @param {any} f */
function peopleRow(r, f) {
  const P = peopleOf(f);
  /** @type {string[]} */
  const apart = [
    ...P.lists.map((/** @type {any} */ x) => `${x.email} (distribution list)`),
    ...P.system.map((/** @type {any} */ x) => `${x.email} (system sender)`),
    ...P.outside.map((/** @type {any} */ x) => (x.label === x.email ? x.email : `${x.label} (${x.email})`)),
  ];
  return specRow('People',
    el('p', null, num(r.staff), ' on the threads, of whom ', num(r.writers), ' wrote. Who writes most is counted here; ownership is under “Named as owner”.'),
    P.writers.length > 0 ? peopleTable(r.key, P.writers, 'Wrote') : null,
    el('p', { class: 'sub-h' }, 'Copied, reading only: ', num(r.copied), ' staff'),
    P.copied.length > 0 ? el('p', { class: 'names' }, `${P.copied.map((/** @type {any} */ x) => x.label).join(', ')}.`) : null,
    apart.length > 0 ? el('p', { class: 'small' }, `Not counted as staff: ${apart.join('; ')}.`) : null,
    el('p', null, link('Everyone on the threads, with their addresses', () => push(participantsLayer(r.key, 'all')))));
}

/** @param {any} r @param {any} f */
function stallsRow(r, f) {
  /** @type {Kid[]} */
  const kinds = [];
  f.stalls_by_kind.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
    if (i > 0) kinds.push(', ');
    kinds.push(...withNums(k.words, [k.count]));
  });
  return specRow('Where it stalls',
    el('p', null, num(r.stall_quotes), kinds.length > 0 ? [': ', ...kinds, '.'] : '.', ' ', num(r.chasers), ' sent.'),
    r.reply_gap === null
      ? el('p', null, 'Reply gap not shown: fewer than 5 replies measured.')
      : el('p', null, 'Replies measured: ', num(r.reply_gap.n), `; typical wait ${r.reply_gap.median_h} hours.`),
    f.stall_groups.map((/** @type {any} */ g) => el('div', { class: 'stall' },
      el('p', { class: 'label' }, 'Summary'),
      el('p', { class: 'prose' }, g.summary),
      g.quotes.map((/** @type {any} */ q) => quoteBlock(q, { counted_in: { process: r.name } })))),
    f.contradictions.map((/** @type {any} */ c) => el('div', { class: 'stall' },
      el('p', { class: 'label' }, 'Where the emails disagree, a summary'),
      el('p', { class: 'prose' }, c.summary),
      c.quotes.map((/** @type {any} */ q) => quoteBlock(q)),
      c.claims.length > 0
        ? el('ul', { class: 'flags' }, c.claims.map((/** @type {any} */ cl) => el('li', null, `Named as owner: “${cl.person}”, ${dateText(cl.date_utc)}, ${cl.status === 'matched' && cl.name !== null ? `matched to ${personName(cl.name, '')}` : (CLAIM_WORDS[cl.status] ?? cl.status)}. `, linkTo('Open the message', { kind: 'message', id: cl.message_id }))))
        : null)),
    f.stall_groups.length === 0 && f.stall_quotes.length > 0 ? el('p', null, link('Read the stall quotes', () => push(stallsLayer(r.key)))) : null);
}

/** @type {Record<string, string>} */
const CLAIM_WORDS = {
  matched: 'matched to someone on the threads',
  several: 'could be any of several people on the threads',
  unmatched: 'not matched to anyone on the threads',
  group: 'a group or role, not one person',
};

/** One owner claim: the name as resolved, when, its status, and the quote. @param {any} c */
function claimBlock(c) {
  return el('div', { class: 'claim' },
    el('p', null, el('b', null, c.name === null ? c.person : personName(c.name, '')), `, named on ${dateText(c.date_utc)}: ${c.status_words}.`, c.name !== null && personName(c.name, '') !== c.person ? ` Written as “${c.person}”.` : ''),
    quoteBlock(c.quote));
}

/** A conflict pair as two claims side by side. @param {any} f @param {any} pair */
function conflictLine(f, pair) {
  const a = f.claims.find((/** @type {any} */ c) => c.message_id === pair.a);
  const b = f.claims.find((/** @type {any} */ c) => c.message_id === pair.b);
  /** @param {any} c @param {string} id */
  const who = (c, id) => [c ? (c.name === null ? c.person : personName(c.name, '')) : id, ' (', linkTo(c ? dateText(c.date_utc) : 'the message', { kind: 'message', id }, { quote: c ? c.quote : undefined }), ')'];
  return el('p', null, 'Two different people named ', plural(pair.days_apart, 'day'), ' apart: ', who(a, pair.a), ' and ', who(b, pair.b), '.');
}

/** @param {any} r @param {any} f */
function ownerRow(r, f) {
  if (f.claims.length === 0) return specRow('Named as owner', el('p', null, 'No one is named as owner in these emails.'));
  return specRow('Named as owner',
    el('p', null, num(r.claims), r.conflicts.v > 0
      ? ['; ', num(r.conflicts), ', each a pair of claims naming two different people close together in time.']
      : r.claims.v > 1 ? '; no two of them name different people close together in time.' : '.'),
    f.claims.map(claimBlock),
    f.conflicts.map((/** @type {any} */ pair) => conflictLine(f, pair)));
}

/** An open-loop item: when, how long before its mailbox's record stops, the subject (opening the
 * message), who, the thread, the quote and the path. @param {any} l @param {{ markRecent?: boolean, from?: string, quiet?: boolean }} [o] */
function loopItem(l, o = {}) {
  const mb = MAILBOX.get(l.mailbox);
  const owner = mb ? mb.owner : l.mailbox;
  const others = l.processes.filter((/** @type {string} */ k) => k !== o.from);
  return el('div', { class: 'loop' },
    el('div', { class: 'loop-date' }, dateText(l.date_utc),
      el('span', null, l.days_before_end === null ? 'no usable date' : `${plural(l.days_before_end, 'day')} before the last message in ${owner}’s mailbox`),
      o.markRecent && l.recent ? el('span', { class: 'recent' }, 'in the last 90 days of the mailbox’s record') : null),
    el('div', { class: 'loop-main' },
      link(l.subject || '(no subject)', () => openTarget({ kind: 'message', id: l.message_id }, { quote: l.quote ?? undefined }), 'loop-subj'),
      el('p', { class: 'loop-meta' }, l.why === 'chase' ? `A chase from ${l.from_label}` : `Waiting for an answer: ${l.from_label}`, ' · ',
        countBtn(`thread of ${plural(l.thread_length, 'message')}`, { kind: 'thread', id: l.thread_id }, `Thread of ${plural(l.thread_length, 'message')}. Opens the thread, oldest first.`, { mark: l.message_id }),
        ` · mailbox last message ${dateText(l.mailbox_end_utc)}`),
      l.quote ? el('p', { class: 'loop-q' }, `“${l.quote.raw_text}”`) : null,
      pathLine(l.message_id),
      o.from !== undefined && others.length > 0 ? el('p', { class: 'small' }, `Also counted under: ${others.map(nameOf).join('; ')}.`) : null,
      mb && mb.received_only && !o.quiet ? el('p', { class: 'caution' }, `${owner}’s replies are not in this archive.`) : null));
}

/** A list of loop items, ten at first. @param {any[]} items @param {{ markRecent?: boolean, from?: string, quiet?: boolean }} o */
function loopList(items, o) {
  const box = el('div', null);
  const first = items.slice(0, 10);
  add(box, first.map((l) => loopItem(l, o)));
  if (items.length > 10) {
    const more = el('button', { type: 'button', class: 'toggle' }, `${plural(items.length - 10, 'more open loop')}`);
    more.addEventListener('click', () => {
      more.remove();
      add(box, items.slice(10).map((l) => loopItem(l, o)));
    });
    box.append(el('p', { class: 'pager' }, more));
  }
  return box;
}

/** Recent first, then newest first. @param {any[]} loops */
const loopOrder = (loops) => [...loops].sort((a, b) => Number(b.recent) - Number(a.recent) || ((b.date_utc ?? '') < (a.date_utc ?? '') ? -1 : (b.date_utc ?? '') > (a.date_utc ?? '') ? 1 : 0));

/** @param {any} r @param {any} f */
function loopsRow(r, f) {
  return specRow('Waiting and open loops',
    el('p', null, num(r.loops), ', ', num(r.loops_recent), ' of them in the last 90 days of the mailbox’s record. ', D.sentences.no_reply),
    receivedOnlyCautions([r.top_mailbox, ...f.loops.map((/** @type {any} */ l) => l.mailbox)]),
    loopList(loopOrder(f.loops), { markRecent: true, from: r.key, quiet: true }));
}

/** The caution for each mailbox among these that holds almost only mail its owner received.
 * @param {string[]} keys */
function receivedOnlyCautions(keys) {
  return [...new Set(keys)].map((k) => MAILBOX.get(k)).filter((mb) => mb && mb.received_only)
    .map((mb) => el('p', { class: 'caution' }, `${mb.owner}’s replies are not in this archive. A request with no visible reply may have been answered.`));
}

/** @param {any} r @param {any} f */
function proposalRow(r, f) {
  const s = f.synthesis;
  return specRow('Our proposal in full',
    s === null ? el('p', null, 'No approach was proposed for this process.') : [
      el('p', { class: 'tag' }, 'The run’s proposed approach, a summary.'),
      el('p', { class: 'prose' }, s.approach),
      el('p', { class: 'tag' }, 'Why, as the run put it.'),
      el('p', { class: 'prose' }, s.rationale),
    ],
    el('p', null, r.document !== null && r.document.status === 'done'
      ? ['Document: ', linkTo(DOC_TITLE[r.document.type] ?? r.document.type, { kind: 'document', key: r.key }), ', drafted, with ', r.document.blanks ? num(r.document.blanks) : 'no items', ' for the owner to confirm.']
      : `${r.status_line}.`));
}

/** @param {any} r @param {any} f */
function numbersRow(r, f) {
  return specRow('The numbers',
    el('p', { class: 'calc' }, num(r.total, { exact: true }), ' a month = ', num(r.counted, { exact: true }), ' counted at published minutes + ', num(r.estimated, { exact: true }),
      ' estimated work. Today the same work costs ', num(r.today, { exact: true }), ' a month (', num(r.hours_today), ' hours).'),
    r.estimate === null
      ? el('p', { class: 'calc' }, 'No estimate passed the checks, so only the counted email is priced.')
      : el('p', { class: 'calc' }, 'Range ', num(r.low, { exact: true }), ' to ', num(r.high, { exact: true }), `, with the work estimate at ${r.estimate.low} or ${r.estimate.high} minutes a round (middle ${r.estimate.mid}). It is not a confidence interval.`),
    r.flags.length > 0 ? el('ul', { class: 'flags' }, r.flags.map((/** @type {string} */ x) => el('li', null, `${cap(x)}.`))) : null,
    el('p', null, el('button', {
      type: 'button',
      class: 'btn',
      onclick: (/** @type {MouseEvent} */ ev) => {
        remember(/** @type {HTMLElement} */ (ev.currentTarget));
        push(formulaLayer(r.key));
      },
    }, 'Open the formula')));
}

// ---------------------------------------------------------------------------------------------
// Layers under a process: the formula, the lists of messages
// ---------------------------------------------------------------------------------------------

/** @param {string} key @returns {Layer} */
function formulaLayer(key) {
  const r = rowOf(key);
  return {
    crumb: `${r.total.x} a month`,
    key,
    render: () => [
      ...head(`${r.name} · the numbers`, `${r.total.x} a month could be automated`),
      el('div', { class: 'eq' },
        el('div', { class: 'eq-part' }, el('b', null, r.total.x), el('span', null, 'a month could be automated')),
        el('span', { class: 'eq-op' }, '='),
        el('div', { class: 'eq-part' }, swatch('counted'), el('b', null, r.counted.x), el('span', null, 'counted email')),
        el('span', { class: 'eq-op' }, '+'),
        el('div', { class: 'eq-part' }, swatch('estimated'), el('b', null, r.estimated.x), el('span', null, 'estimated work'))),
      el('p', { class: 'calc' }, `${r.counted.x} counted + ${r.estimated.x} estimated = ${r.total.x} a month; at `, num(D.rates.hourly), ` an hour that is ${r.hours.x} a month.`),
      deferred(loadProcess(key), (f) => formulaDetails(r, f), 'the process data'),
    ],
  };
}

/** @param {any} r @param {any} f */
function formulaDetails(r, f) {
  const months = hundredths(f.window.months_x100);
  const rounds = hundredths(f.occurrence_share_x100);
  const unpriced = ACTION_ORDER.filter((t) => (f.actions.unpriced[t] ?? 0) > 0).map((t) => `${grouped(f.actions.unpriced[t])} ${(ACTION_TITLE[t] ?? t).toLowerCase()}`);
  const est = r.estimate;
  return [el('div', { class: 'spec' },
    specRow('Counted at published minutes',
      el('p', { class: 'calc' }, 'Seen ', num(r.occurrences), ` over ${plural(f.window.span_days, 'day')}, which the run counts as ${months} months.`,
        r.shared_occurrences > 0 ? ` ${r.shared_occurrences === 1 ? 'One round is' : `${cap(numberWord(r.shared_occurrences))} rounds are`} shared with another process, so this process counts ${rounds} rounds.` : ''),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Email action'), th('Count', 'r'), th('Minutes each', 'r'), th('Minutes', 'r'), th('Automatable', 'r'), th('Automatable minutes', 'r'))),
        el('tbody', null, f.action_table.map((/** @type {any} */ a) => el('tr', null,
          el('td', null, cap(a.words)),
          el('td', { class: 'r' }, a.count.v > 0 ? num(a.count, { ctx: { counted_in: { process: r.name } } }) : a.count.t),
          el('td', { class: 'r' }, String(a.minutes_each)),
          el('td', { class: 'r' }, a.minutes),
          el('td', { class: 'r' }, `${a.automatable_pct}%`),
          el('td', { class: 'r' }, a.automatable_minutes)))))),
      el('p', { class: 'calc' }, `After sharing: ${hundredths(f.email.today_x100)} minutes, ${hundredths(f.email.automatable_x100)} of them automatable. Over ${months} months: ${hundredths(f.email.per_month_automatable_x100)} automatable minutes a month = `,
        el('b', null, `${r.counted.x} a month`), ', counted.'),
      unpriced.length > 0 ? el('p', { class: 'small' }, `Not priced: ${unpriced.join(', ')} (distribution lists and system senders are never staff).`) : null,
      el('p', { class: 'small' }, 'Rates: ', num(D.rates.hourly), ' an hour; the published minutes and shares are under ', link('How we measured', () => goMethod('rates')), '.')),
    specRow('Estimated from the emails',
      est === null || f.work === null
        ? el('p', { class: 'calc' }, 'No estimate passed the checks, so only the counted email is priced.')
        : [
          el('p', { class: 'calc' }, `${rounds} rounds × ${est.mid} minutes a round (range ${est.low} to ${est.high}), over ${months} months: ${hundredths(f.work.per_month_today_x100)} minutes a month of hands-on work. ${est.automatable_pct}% of it could be automated: ${hundredths(f.work.per_month_automatable_x100)} minutes a month = `,
            el('b', null, `${r.estimated.x} a month`), ', estimated.'),
          el('p', { class: 'calc' }, est.source === 'override' ? 'Set by the project team in a file, in place of the run’s estimate. ' : `Basis: ${est.basis_words}, from `,
            countBtn(plural(f.estimate_quotes.length, 'cited quote'), { kind: 'evidence', key: r.key, set: 'estimate' }),
            f.estimate_check ? ` across ${plural(f.estimate_check.occurrences_cited, 'round')} and ${plural(f.estimate_check.senders_cited, 'sender')}` : '',
            '. Checked by code: its bounds, its citations, and never one sender alone.'),
        ]),
    specRow('Range',
      est === null
        ? el('p', { class: 'calc' }, 'With no work estimate, the range is the counted email alone.')
        : el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
          el('thead', null, el('tr', null, th('Work estimate'), th('Minutes a round', 'r'), th('Counted email', 'r'), th('Total a month', 'r'))),
          el('tbody', null,
            el('tr', null, el('td', null, 'Low'), el('td', { class: 'r' }, String(est.low)), el('td', { class: 'r' }, r.counted.x), el('td', { class: 'r' }, r.low.x)),
            el('tr', null, el('td', null, 'Middle'), el('td', { class: 'r' }, String(est.mid)), el('td', { class: 'r' }, r.counted.x), el('td', { class: 'r' }, r.total.x)),
            el('tr', null, el('td', null, 'High'), el('td', { class: 'r' }, String(est.high)), el('td', { class: 'r' }, r.counted.x), el('td', { class: 'r' }, r.high.x))))),
      est === null ? null : el('p', { class: 'small' }, 'Not a confidence interval: the run’s own low and high minutes for one round. The counted part does not move.')),
    specRow('Today',
      el('p', { class: 'calc' }, `${r.today.x} a month of this work today (${r.hours_today.x}); ${r.total.x} of it could be automated.`),
      el('p', { class: 'small' }, 'Rates file ', el('code', null, D.rates.file), ' · sha256 ', el('span', { class: 'hash' }, D.rates.sha))),
    specRow('As the run wrote it',
      el('p', { class: 'tag' }, 'The formula lines from the scoring step, word for word.'),
      el('pre', { class: 'formula-raw' }, [f.formula.counted, f.formula.estimated, f.formula.total].filter((x) => x !== null).join('\n'))))];
}

/** The messages behind one count of a process, each opening the viewer with the action named.
 * @param {string} key @param {string} type @param {string} [person] @param {string} [personLabel] @returns {Layer} */
function actionsLayer(key, type, person, personLabel) {
  const r = rowOf(key);
  const types = type === 'authored' ? ['authored_short', 'authored_medium', 'authored_long'] : [type];
  const title = ACTION_TITLE[type] ?? type;
  return {
    crumb: person ? `${title}: ${personLabel ?? person}` : title,
    key,
    render: () => [
      ...head(`${r.name} · counted`, person ? `${title} by ${personLabel ?? person}` : title),
      deferred(Promise.all([loadProcess(key), loadIndex()]), ([f, ix]) => {
        const label = person ? (f.participants.find((/** @type {any} */ p) => p.email === person)?.label ?? personLabel ?? person) : undefined;
        const src = f.action_sources.filter((/** @type {any} */ s) => s.priced && types.includes(s.type) && (person === undefined || s.person === person));
        /** @type {Map<string, any[]>} */
        const byMsg = new Map();
        for (const s of src) byMsg.set(s.message_id, [...(byMsg.get(s.message_id) ?? []), s]);
        const ids = [...byMsg.keys()].sort((a, b) => {
          const da = ix.get(a)?.date_utc ?? '9999';
          const db = ix.get(b)?.date_utc ?? '9999';
          return da < db ? -1 : da > db ? 1 : a < b ? -1 : a > b ? 1 : 0;
        });
        return [
          el('p', { class: 'calc' }, type === 'read' && person === undefined
            ? `${plural(src.length, 'read')} across ${plural(ids.length, 'message')}: one per staff addressee, up to ${D.rates.read_cap} a message.`
            : `${plural(src.length, type === 'read' ? 'read' : 'message')}, each counted once as this action${label ? `, by ${label}` : ''}.`),
          paged(ids, (id) => {
            const list = /** @type {any[]} */ (byMsg.get(id));
            const s0 = list[0];
            const note = type === 'read' && person === undefined ? plural(list.length, 'read') : type === 'authored' ? (ACTION_RATE_WORDS[s0.type] ?? '').toLowerCase() : '';
            const byLabel = f.participants.find((/** @type {any} */ p) => p.email === s0.person)?.label;
            return msgItem(ix.get(id), id, { note, d: { kind: 'message', id, action: s0.type }, ctx: { counted_in: { process: r.name, by: s0.type === 'read' ? undefined : byLabel } } });
          }),
        ];
      }, 'the messages'),
    ],
  };
}

/** Every round of a process, by month, each listing its messages; or one month's rounds.
 * @param {string} key @param {string} [month] @returns {Layer} */
function occurrencesLayer(key, month) {
  const r = rowOf(key);
  return {
    crumb: month ? monthText(month) : r.occurrences.t,
    key,
    render: () => [
      ...head(`${r.name} · how often`, month ? `${monthText(month)}` : ['Seen ', r.occurrences.t]),
      deferred(Promise.all([loadProcess(key), loadIndex()]), ([f, ix]) => {
        const byId = new Map(f.occurrences.map((/** @type {any} */ o) => [o.id, o]));
        const months = f.monthly.filter((/** @type {any} */ mo) => month === undefined || mo.month === month);
        /** @param {any} o */
        const round = (o) => o.message_ids.map((/** @type {string} */ id, /** @type {number} */ j) => msgItem(ix.get(id), id, { note: o.message_ids.length > 1 ? (j === 0 ? `a round of ${plural(o.message_ids.length, 'message')}` : 'same round') : '' }));
        return [
          month ? el('p', { class: 'calc' }, plural(months[0]?.ids.length ?? 0, 'round'), ' in the month. ', link(`Show all ${r.occurrences.t}`, () => replaceTop(occurrencesLayer(key)))) : el('p', { class: 'calc' }, ...seenLine(r, { kind: 'occurrences', key })),
          months.map((/** @type {any} */ mo) => [
            el('p', { class: 'month-h' }, `${monthText(mo.month)} · ${plural(mo.ids.length, 'round')}`),
            el('ul', { class: 'mlist' }, mo.ids.map((/** @type {string} */ id) => round(byId.get(id) ?? { message_ids: [] }))),
          ]),
          month === undefined && f.undated_occurrences.length > 0 ? [
            el('p', { class: 'month-h' }, `No usable date · ${plural(f.undated_occurrences.length, 'round')}`),
            el('ul', { class: 'mlist' }, f.undated_occurrences.map((/** @type {string} */ id) => round(byId.get(id) ?? { message_ids: [] }))),
          ] : null,
        ];
      }, 'the rounds'),
    ],
  };
}

/** The months a process was seen in, each opening its rounds. @param {string} key @returns {Layer} */
function monthsLayer(key) {
  const r = rowOf(key);
  return {
    crumb: r.active_months.t,
    key,
    render: () => [
      ...head(`${r.name} · how often`, cap(r.active_months.t)),
      deferred(loadProcess(key), (f) => [
        el('p', { class: 'calc' }, ...seenLine(r, { kind: 'months', key })),
        el('ul', { class: 'mlist' }, f.monthly.map((/** @type {any} */ mo) => el('li', null, el('div', { class: 'mitem' },
          el('div', { class: 'mitem-d' }, monthShort(mo.month)),
          el('div', null, num(mo.occurrences, { after: mo.occurrences.v === 1 ? ' round' : ' rounds' }), ` · ${plural(mo.messages, 'email')}`))))),
      ], 'the months'),
    ],
  };
}

/** The quotes behind an estimate, or every accepted quote of a process. @param {string} key @param {'estimate' | 'all'} set @returns {Layer} */
function evidenceLayer(key, set) {
  const r = rowOf(key);
  return {
    crumb: set === 'estimate' ? 'The emails behind the estimate' : 'Every quote',
    key,
    render: () => [
      ...head(`${r.name} · ${set === 'estimate' ? 'estimated work' : 'evidence'}`, set === 'estimate' ? 'The emails behind the estimate' : 'Every accepted quote'),
      deferred(loadProcess(key), (f) => {
        const qs = set === 'estimate' ? f.estimate_quotes : f.evidence;
        const est = r.estimate;
        return [
          el('p', { class: 'calc' }, set === 'estimate' && est
            ? `${plural(qs.length, 'quote')} cited for ${est.mid} minutes a round (range ${est.low} to ${est.high}), ${est.automatable_pct}% automatable${f.estimate_check ? `, from ${plural(f.estimate_check.occurrences_cited, 'round')} and ${plural(f.estimate_check.senders_cited, 'sender')}` : ''}.`
            : `${plural(qs.length, 'quote')}, each checked against its message before it was counted.`),
          qs.length === 0 ? el('p', { class: 'note' }, 'No quote in this set.') : null,
          qs.map((/** @type {any} */ q) => el('div', null, quoteBlock(q, { counted_in: { process: r.name } }),
            el('p', { class: 'q-note' }, `${q.match === 'exact' ? 'Exact match' : 'Repaired match (equal once spacing and line breaks are set aside)'} · quote ${q.id}`))),
          set === 'estimate' ? el('p', null, link('Every accepted quote of this process', () => push(evidenceLayer(key, 'all')))) : null,
        ];
      }, 'the quotes'),
    ],
  };
}

/** @param {string} key @param {string} filter @returns {Layer} */
function participantsLayer(key, filter) {
  const r = rowOf(key);
  const title = { staff: 'Staff on the threads', writers: 'Staff who wrote', copied: 'Staff copied, reading only', all: 'Everyone on the threads' }[filter] ?? 'People';
  return {
    crumb: title,
    key,
    render: () => [
      ...head(`${r.name} · people`, title),
      el('p', { class: 'small' }, 'After folding one person’s several addresses into one. Distribution lists, system senders and addresses outside the staff are not staff.'),
      deferred(loadProcess(key), (f) => {
        const P = peopleOf(f);
        if (filter === 'writers') return [peopleTable(key, P.writers, 'Name or address')];
        if (filter === 'copied') return [peopleTable(key, P.copied, 'Name or address')];
        if (filter === 'staff') return [peopleTable(key, [...P.writers, ...P.copied], 'Name or address')];
        return [
          el('p', { class: 'label' }, `Staff: ${grouped(P.writers.length + P.copied.length)}`),
          peopleTable(key, [...P.writers, ...P.copied], 'Name or address'),
          P.lists.length ? [el('p', { class: 'label' }, `Distribution lists: ${grouped(P.lists.length)}`), peopleTable(key, P.lists, 'Address')] : null,
          P.system.length ? [el('p', { class: 'label' }, `System senders: ${grouped(P.system.length)}`), peopleTable(key, P.system, 'Address')] : null,
          P.outside.length ? [el('p', { class: 'label' }, `Other addresses, not staff: ${grouped(P.outside.length)}`), peopleTable(key, P.outside, 'Name or address')] : null,
        ];
      }, 'the people'),
    ],
  };
}

/** The stall quotes of a process: the summaries with their cited quotes, then the rest by kind.
 * @param {string} key @param {string} [kind] @returns {Layer} */
function stallsLayer(key, kind) {
  const r = rowOf(key);
  return {
    crumb: kind ? 'Stall quotes of one kind' : r.stall_quotes.t,
    key,
    render: () => {
      const top = head(`${r.name} · where it stalls`, kind ? 'Stall quotes of one kind' : cap(r.stall_quotes.t));
      return [...top, deferred(loadProcess(key), (f) => {
        const words = kind ? f.stalls_by_kind.find((/** @type {any} */ k) => k.kind === kind)?.words : null;
        // This layer's own title, wherever the reader has gone since.
        if (words) /** @type {HTMLElement} */ (top[1]).textContent = cap(words);
        const quotes = f.stall_quotes.filter((/** @type {any} */ q) => kind === undefined || q.stall_kind === kind);
        const cited = new Set();
        /** @type {Kid[]} */
        const groups = [];
        for (const g of f.stall_groups) {
          const qs = g.quotes.filter((/** @type {any} */ q) => q.kind === 'stall' && (kind === undefined || q.stall_kind === kind));
          if (qs.length === 0) continue;
          qs.forEach((/** @type {any} */ q) => cited.add(q.id));
          groups.push(el('div', { class: 'stall' }, el('p', { class: 'label' }, 'Summary'), el('p', { class: 'prose' }, g.summary), qs.map((/** @type {any} */ q) => quoteBlock(q))));
        }
        const rest = quotes.filter((/** @type {any} */ q) => !cited.has(q.id));
        /** @type {Map<string, any[]>} */
        const byKind = new Map();
        for (const q of rest) byKind.set(q.stall_kind, [...(byKind.get(q.stall_kind) ?? []), q]);
        const kindWords = new Map(f.stalls_by_kind.map((/** @type {any} */ k) => [k.kind, k.words]));
        return [
          el('p', { class: 'calc' }, `${plural(quotes.length, 'stall quote')}. Each was checked against its message before it was counted.`),
          groups,
          rest.length > 0 ? el('p', { class: 'label' }, groups.length > 0 ? 'Not cited in a summary' : 'The quotes') : null,
          [...byKind.entries()].map(([k, qs]) => el('div', { class: 'stall' }, el('p', { class: 'sub-h' }, cap(String(kindWords.get(k) ?? k).replace(/^\d[\d,]*\s+/, ''))), qs.map((q) => quoteBlock(q)))),
        ];
      }, 'the stall quotes')];
    },
  };
}

/** @param {string} key @returns {Layer} */
function claimsLayer(key) {
  const r = rowOf(key);
  return {
    crumb: 'Named as owner',
    key,
    render: () => [
      ...head(`${r.name} · named as owner`, 'Who the emails name as owner'),
      deferred(loadProcess(key), (f) => [
        el('p', { class: 'calc' }, 'A name is matched only when it resolves to someone on the process’s threads; a conflict is a pair of matched claims naming two different people close together in time.'),
        f.claims.length === 0 ? el('p', null, 'No one is named as owner in these emails.') : f.claims.map(claimBlock),
        f.conflicts.length > 0 ? [el('p', { class: 'label' }, 'Conflicts'), f.conflicts.map((/** @type {any} */ p) => conflictLine(f, p))] : null,
      ], 'the claims'),
    ],
  };
}

/** The replies measured: each pair of messages and the wait between them. @param {string} key @returns {Layer} */
function gapsLayer(key) {
  const r = rowOf(key);
  return {
    crumb: 'Replies measured',
    key,
    render: () => [
      ...head(`${r.name} · replies`, 'Replies measured'),
      deferred(Promise.all([loadProcess(key), loadIndex()]), ([f, ix]) => [
        el('p', { class: 'calc' }, `${plural(f.reply_gaps.length, 'reply', 'replies')} measured${r.reply_gap ? `, typical wait ${r.reply_gap.median_h} hours` : ''}: from a message of this process to the next message in its thread by someone else.`),
        f.reply_gaps.map((/** @type {any} */ g) => el('div', { class: 'stall' },
          el('p', { class: 'sub-h' }, `${tenths(g.hours_x10)} hours`),
          el('ul', { class: 'mlist' }, msgItem(ix.get(g.from), g.from, { note: 'the message' }), msgItem(ix.get(g.to), g.to, { note: 'the reply' })))),
      ], 'the replies'),
    ],
  };
}

/** @param {string} key @param {boolean} recent @returns {Layer} */
function processLoopsLayer(key, recent) {
  const r = rowOf(key);
  return {
    crumb: recent ? 'Open loops, last 90 days' : r.loops.t,
    key,
    render: () => [
      ...head(`${r.name} · waiting`, recent ? 'Open loops in the last 90 days of the record' : cap(r.loops.t)),
      el('p', { class: 'calc' }, D.sentences.no_reply),
      deferred(loadProcess(key), (f) => {
        const ls = loopOrder(f.loops.filter((/** @type {any} */ l) => !recent || l.recent));
        return [receivedOnlyCautions(ls.map((l) => l.mailbox)), loopList(ls, { markRecent: true, from: key, quiet: true })];
      }, 'the open loops'),
    ],
  };
}

/** The recent open loops of the processes with a drafted document. @returns {Layer} */
function draftedLoopsLayer() {
  return {
    crumb: 'Open loops in drafted processes',
    render: () => [
      ...head('Open loops', 'Still open in the processes with a document'),
      el('p', { class: 'calc' }, D.sentences.no_reply),
      deferred(loadLoops(), (L) => {
        const keys = new Set(draftedRows().map((/** @type {any} */ r) => r.key));
        return [loopList(L.filter((/** @type {any} */ l) => l.recent && l.processes.some((/** @type {string} */ k) => keys.has(k))), {})];
      }, 'the open loops'),
    ],
  };
}

/** @param {string} key @returns {Layer} */
function documentLayer(key) {
  const r = rowOf(key);
  const type = r.document ? (DOC_TITLE[r.document.type] ?? r.document.type) : 'Document';
  return {
    crumb: type,
    key,
    render: () => [
      ...head(`${r.name} · drafted document`, type),
      deferred(loadProcess(key), (f) => {
        const doc = f.document;
        if (doc === null || doc.markdown === null) return [el('p', { class: 'note' }, r.status_line)];
        // The evidence ids open their message; each opens with its quote marked when one of the
        // process's checked quotes is that same text in that message (compared, never searched for).
        const body = el('div', { class: 'doc' }, renderMarkdown(doc.markdown, { onMessageId: () => {} }));
        linkEvidence(body, f, r.name);
        return [
          el('p', { class: 'calc' }, doc.blanks ? el('b', null, doc.blanks.t) : 'No items', ' for the owner to confirm (the owner, values it proposes and rules taken from a single email), marked in the text below with the other blanks: fields filled in each time it is used, and a few set once, such as where a shared list lives.'),
          body,
          el('p', { class: 'small' }, 'Drafted from the cited emails for the process owner to review; shown as drafted.'),
        ];
      }, 'the document'),
    ],
  };
}

/** Every checked quote a process file holds. @param {any} f @returns {any[]} */
export function quotesOf(f) {
  return [
    ...f.evidence,
    ...f.estimate_quotes,
    ...f.stall_quotes,
    ...f.stall_groups.flatMap((/** @type {any} */ g) => g.quotes),
    ...f.claims.map((/** @type {any} */ c) => c.quote),
    ...f.contradictions.flatMap((/** @type {any} */ c) => c.quotes),
    ...f.loops.map((/** @type {any} */ l) => l.quote).filter(Boolean),
  ];
}

/** The checked quote of a message whose text is this text, spacing and line breaks aside; failing
 * that, its letters and digits (a quote whose asterisks the document's Markdown read as bold); or null.
 * @param {any[]} quotes @param {string} id @param {string} text */
export function quoteFor(quotes, id, text) {
  const mine = quotes.filter((q) => q.message_id === id);
  for (const squash of [(/** @type {string} */ s) => s.replace(/\s+/g, ''), (/** @type {string} */ s) => s.replace(/[^\p{L}\p{N}]+/gu, '')]) {
    const want = squash(text);
    if (want === '') return null;
    const q = mine.find((x) => squash(x.raw_text) === want);
    if (q !== undefined) return q;
  }
  return null;
}

/** Makes a drafted document's message ids open their message, the quote under each marked.
 * @param {HTMLElement} root @param {any} f @param {string} name */
function linkEvidence(root, f, name) {
  const quotes = quotesOf(f);
  root.querySelectorAll('button.msg').forEach((node) => {
    const b = /** @type {HTMLElement} */ (node);
    const id = b.textContent ?? '';
    const said = b.closest('li')?.querySelector('blockquote')?.textContent ?? '';
    const q = quoteFor(quotes, id, said);
    if (q !== null) b.setAttribute('data-quote', q.id);
    b.addEventListener('click', () => {
      remember(b);
      push(messageLayer(id, { quote: q, counted_in: { process: name } }));
    });
  });
}

/** The data's figure for every item to confirm across the drafted documents (its target is the
 * documents layer), or null. @returns {Num | null} */
const blanksTotal = () => D.next_steps.flatMap((/** @type {any} */ s) => s.nums).find((/** @type {Num} */ n) => n.d.kind === 'documents') ?? null;

/** The table of every document the run could draft, with its blanks and status, and the items to
 * confirm across them. @param {Target} [here] */
function documentsTable(here) {
  const done = D.documents.filter((/** @type {any} */ d) => d.status === 'done').length;
  const total = blanksTotal();
  return el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
    el('thead', null, el('tr', null, th('Rank', 'r'), th('Process'), th('Document'), th('To confirm', 'r'), th('Status'))),
    el('tbody', null, D.documents.map((/** @type {any} */ d) => {
      const r = rowOf(d.key);
      return el('tr', null,
        el('td', { class: 'r' }, r ? String(r.rank) : ''),
        el('td', null, link(nameOf(d.key), () => openTarget({ kind: 'process', key: d.key }))),
        el('td', null, d.status === 'done' ? linkTo(DOC_TITLE[d.type] ?? d.type, { kind: 'document', key: d.key }) : (DOC_TITLE[d.type] ?? '')),
        el('td', { class: 'r' }, d.blanks ? num(d.blanks) : ''),
        el('td', null, d.status === 'done' ? 'Drafted' : (r ? r.status_line : (d.reason ?? d.status))));
    })),
    total === null ? null : el('tfoot', null, el('tr', null, el('td'), el('td', null, `${cap(plural(done, 'document'))}`), el('td'),
      el('td', { class: 'r' }, num(total, { here })), el('td')))));
}

/** @returns {Layer} */
function documentsLayer() {
  const done = D.documents.filter((/** @type {any} */ d) => d.status === 'done').length;
  const total = blanksTotal();
  const here = { kind: 'documents' };
  return {
    crumb: 'Drafted documents',
    render: () => [
      ...head('Drafted documents', `${cap(plural(done, 'document'))} for an owner to confirm`),
      total === null ? null : el('p', { class: 'plain' }, num(total, { here }), ` to confirm across ${plural(done, 'document')}.`),
      el('p', { class: 'calc' }, D.sentences.threshold),
      documentsTable(here),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Messages, threads, the lookup
// ---------------------------------------------------------------------------------------------

const viewerApi = {
  fetchMessage,
  index: () => loadIndexArray(),
  get rates() {
    return D.rates;
  },
  processName: (/** @type {string} */ k) => ROWS.get(k)?.name,
  mailboxOwner: (/** @type {string} */ k) => MAILBOX.get(k)?.owner,
  open: (/** @type {string} */ id) => push(messageLayer(id, {})),
};

/** The viewer for one message. @param {string} id @param {{ quote?: any, action?: string | null, counted_in?: any }} o @returns {Layer} */
function messageLayer(id, o) {
  return {
    crumb: id.replace(/^corpus\//, ''),
    render: () => {
      const host = el('div', { class: 'viewer' });
      void messageView(host, viewerApi, { id, quote: o.quote ?? null, action: o.action ?? null, counted_in: o.counted_in ?? null });
      return [host];
    },
  };
}

/** A thread's messages, oldest first, the open-loop message marked. @param {string} id @param {string} [mark] @returns {Layer} */
function threadLayer(id, mark) {
  return {
    crumb: 'The thread',
    render: () => [
      ...head('Thread', 'The thread, oldest first'),
      deferred(loadIndexArray(), (ix) => {
        const rows = ix.filter((/** @type {any} */ r) => r.thread_id === id).sort((/** @type {any} */ a, /** @type {any} */ b) => {
          const da = a.date_utc ?? '9999';
          const db = b.date_utc ?? '9999';
          return da < db ? -1 : da > db ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return [
          el('p', { class: 'calc' }, `${plural(rows.length, 'message')} in these mailboxes.${mark ? ' The marked one is the last, still open when the record stops.' : ''}`),
          el('ul', { class: 'mlist' }, rows.map((/** @type {any} */ r) => msgItem(r, r.id, { mark: r.id === mark, note: r.id === mark ? 'the last message, still open' : '' }))),
        ];
      }, 'the thread'),
    ],
  };
}

/** @returns {Layer} */
function lookupLayer() {
  const ids = [...new Set(D.findings.map((/** @type {any} */ f) => f.quote?.message_id).filter(Boolean))].slice(0, 3);
  return {
    crumb: 'Look up a message',
    render: () => [
      ...head('Message lookup', 'Look up a message'),
      el('p', { class: 'calc' }, 'Paste a message ID exactly as cited, trailing dot included. Any of the ', num(D.scope.files), ' opens with its headers and body.'),
      lookupForm(viewerApi, { placeholder: String(ids[0] ?? 'corpus/<mailbox>/<folder>/<number>.') }),
      ids.length > 0 ? el('p', { class: 'small' }, 'Try: ', ids.map((x, i) => [i > 0 ? ', ' : '', linkTo(String(x), { kind: 'message', id: String(x) }, {}, 'link mono')])) : null,
    ],
  };
}

/** A coverage bucket: what it holds and every message in it, a hundred at a time. @param {string} bucket @returns {Layer} */
function coverageLayer(bucket) {
  return {
    crumb: BUCKET_TITLE[bucket] ?? bucket,
    render: () => [
      ...head('Every message, accounted for', BUCKET_TITLE[bucket] ?? bucket),
      deferred(Promise.all([loadMethod(), loadIndex()]), ([M, ix]) => {
        const c = M.coverage.find((/** @type {any} */ x) => x.bucket === bucket);
        if (!c) return [el('p', { class: 'note' }, 'No such group in the data.')];
        return [
          el('p', { class: 'calc' }, el('b', null, `${c.count.t} messages. `), c.words),
          bucket === 'unassigned' ? el('p', null, link('The process names proposed for them', () => push(slugsLayer('unassigned')))) : null,
          bucket === 'duplicates' ? el('p', null, link('The copies, by original', () => push(dedupLayer()))) : null,
          paged(c.ids, (/** @type {string} */ id) => msgItem(ix.get(id), id)),
        ];
      }, 'the message list'),
    ],
  };
}

/** The process names proposed while reading: the unassigned ones, or all of them. @param {'unassigned' | 'all'} which @returns {Layer} */
function slugsLayer(which) {
  return {
    crumb: which === 'all' ? 'Every proposed name' : 'Names left unassigned',
    render: () => [
      ...head('Merging the process names', which === 'all' ? 'Every name proposed while reading' : 'Names left unassigned'),
      deferred(loadMethod(), (M) => {
        const list = which === 'all' ? M.merge.slugs : M.unassigned_slugs;
        return [
          el('p', { class: 'calc' }, M.merge.sentence),
          el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
            el('thead', null, el('tr', null, th('Proposed name'), th('Messages', 'r'), th('Outcome'), which === 'all' ? th('Counted under') : null, th('Reason'))),
            el('tbody', null, list.map((/** @type {any} */ s) => el('tr', null,
              el('td', null, el('code', null, s.slug)),
              el('td', { class: 'r' }, grouped(s.messages)),
              el('td', null, s.status),
              which === 'all' ? el('td', null, s.to ? (ROWS.has(s.to) ? link(nameOf(s.to), () => openTarget({ kind: 'process', key: s.to })) : s.to) : '') : null,
              el('td', null, s.reason ?? '')))))),
        ];
      }, 'the names'),
    ],
  };
}

/** @returns {Layer} */
function dedupLayer() {
  return {
    crumb: 'Duplicates',
    render: () => [
      ...head('Every message, accounted for', 'Copies of another message'),
      deferred(loadMethod(), (M) => [
        el('p', { class: 'calc' }, 'Each copy is counted once, as its original. Recipients that differ between copies are noted.'),
        M.dedup.map((/** @type {any} */ g) => el('div', { class: 'stall' },
          el('p', { class: 'sub-h' }, 'Original: ', linkTo(g.canonical, { kind: 'message', id: g.canonical }, {}, 'link mono')),
          el('ul', { class: 'flags' }, g.duplicates.map((/** @type {any} */ x) => el('li', null, linkTo(x.id, { kind: 'message', id: x.id }, {}, 'link mono'), ` · same ${x.rule}${x.recipients_differ ? ' · recipients differ' : ''}`))))),
      ], 'the duplicates'),
    ],
  };
}

/** A plain list layer (identity lists and the like). @param {string} kicker @param {string} title @param {Kid[]} body @returns {Layer} */
function listLayer(kicker, title, body) {
  return { crumb: title, render: () => [...head(kicker, title), ...body] };
}

// ---------------------------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------------------------

const VIEWS = ['overview', 'all-processes', 'open-loops', 'methodology'];
function currentView() {
  const h = location.hash.replace('#', '');
  return VIEWS.includes(h) ? h : 'overview';
}
let pendingSection = /** @type {string | null} */ (null);
// What to do once the next view is applied instead of scrolling to its top (the range button's scroll to the chart).
let afterView = /** @type {(() => void) | null} */ (null);

/** @param {string} view */
function go(view) {
  if (isOpen()) closeDrawer();
  // The view shown already (the overview at "/" too) is applied now, with no history entry.
  if (currentView() !== view) location.hash = view;
  else applyView();
}

/** Methodology, scrolled to one of its sections. @param {string} section */
function goMethod(section) {
  pendingSection = section;
  go('methodology');
}

const rendered = new Set();
function applyView() {
  const v = currentView();
  for (const id of VIEWS) $(`#${id}`).hidden = id !== v;
  document.querySelectorAll('.nav a').forEach((a) => {
    if (/** @type {HTMLElement} */ (a).dataset.view === v) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (v === 'all-processes' && !rendered.has(v)) {
    rendered.add(v);
    renderAll();
  }
  if (v === 'open-loops' && !rendered.has(v)) {
    rendered.add(v);
    renderLoops(false);
  }
  if (v === 'methodology' && !rendered.has(v)) {
    rendered.add(v);
    renderMethod();
  }
  if (v === 'overview') drawCharts();
  if (v === 'methodology' && pendingSection !== null) scrollToSection();
  else if (afterView !== null) {
    const then = afterView;
    afterView = null;
    then();
  } else window.scrollTo(0, 0);
}

function scrollToSection() {
  const target = document.getElementById(`method-${pendingSection}`);
  if (target === null) return; // scrolled once the methodology arrives
  pendingSection = null;
  document.querySelectorAll('.ol-sec.is-target').forEach((x) => x.classList.remove('is-target'));
  target.classList.add('is-target');
  target.scrollIntoView({ block: 'start' });
  const h = target.querySelector('h3');
  if (h instanceof HTMLElement) {
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
}

// ---- Overview ----

let listN = 10;

export function renderOverview() {
  const H = D.headline;
  const S = D.sentences;
  const host = el('div', { class: 'chart-host' });
  const value = el('section', { class: 'value', 'aria-labelledby': 'hl' },
    el('div', { class: 'value-row' },
      el('h2', { class: 'value-big', id: 'hl' }, num(H.total, { after: ' a month', label: `${H.total.t} a month could be automated: ${H.counted.t} of email time counted plus ${H.estimated.t} of hands-on work estimated. Opens what it is made of.` })),
      el('p', { class: 'value-what' }, num(H.hours, { after: ' hours a month' }), ' of recurring work could be automated.')),
    el('p', { class: 'value-parts' },
      el('span', null, swatch('counted'), num(H.counted), ' counted from the emails'),
      el('span', { class: 'value-sep', 'aria-hidden': 'true' }, '·'),
      el('span', null, swatch('estimated'), num(H.estimated), ' estimated from them')),
    el('div', { class: 'value-lines' },
      el('p', null, S.scope),
      el('p', null, ...withNums(S.today, [H.today, H.hours_today, H.total])),
      el('p', null, S.split, ' ', ...withNums(S.range, [H.low, H.high]))));
  value.append(el('div', { class: 'value-links' },
    link('How to read these numbers', () => openTarget({ kind: 'method', section: 'explainer' }), 'link howto'),
    el('p', { class: 'caution-line' }, S.caution, ' ', link('See where this comes from', () => openTarget({ kind: 'mailbox' })))));

  const top3 = D.cumulative[Math.min(D.findings.length, D.cumulative.length) - 1];
  const found = el('section', { class: 'sec', 'aria-labelledby': 'f-h' },
    el('div', { class: 'sec-head' }, el('h2', { id: 'f-h' }, 'What we found'),
      top3 ? el('p', null, `The ${D.findings.length === 1 ? 'biggest' : `${numberWord(D.findings.length)} biggest`}: `, num(top3.cents, { after: ' a month' }), D.findings.length === 1 ? '.' : ' together.') : null),
    el('div', { class: 'findings' }, D.findings.map(finding)));

  const rangeBtn = el('button', { type: 'button', class: 'rangebtn', 'aria-pressed': String(showRange), onclick: () => setRange(!showRange) },
    swatch('band'), showRange ? 'Hide the range' : 'Show the range');
  const chart = el('section', { class: 'sec', 'aria-labelledby': 'c-h' },
    el('div', { class: 'sheet' },
      el('div', { class: 'sheet-head' },
        el('h3', { id: 'c-h' }, 'Where the ', num(H.total), ' comes from, biggest first'),
        el('div', { class: 'legend' },
          el('span', null, swatch('counted'), 'counted from the emails'),
          el('span', null, swatch('estimated'), 'estimated from the emails'),
          rangeBtn)),
      host,
      el('div', { class: 'sheet-foot' },
        el('span', null, 'Each step is one process, numbered by rank. Point at a step to read it; select it to open it.'),
        H.rows_below.v > 0 ? el('span', null, 'Not in the total: ', num(H.rows_below, { after: ' processes' }), ' seen too rarely to count, ', num(H.below_cents, { after: ' a month' }), '.') : null)));

  const list = el('section', { class: 'sec', id: 'ranked', 'aria-labelledby': 'r-h' },
    el('div', { class: 'sec-head' }, el('h2', { id: 'r-h' }, 'Every process, ranked'),
      el('p', null, 'By what could be automated, in dollars a month; ties by name.')),
    el('div', { class: 'tablewrap' }, el('table', { class: 'rank', id: 'rank-table' })));

  const next = el('section', { class: 'sec', 'aria-labelledby': 'n-h' },
    el('div', { class: 'sec-head' }, el('h2', { id: 'n-h' }, 'Next steps')),
    nextSteps());

  const v = $('#overview');
  v.replaceChildren(value, found, chart, list, next);
  for (let i = charts.length - 1; i >= 0; i--) if (!charts[i]?.mini) charts.splice(i, 1);
  charts.push({ host, mini: false });
  pareto(host, false);
  renderList();
}

/** One of the three findings: value, where it stalls, what would fix it, the document, a quote.
 * @param {any} f */
function finding(f) {
  const r = rowOf(f.key);
  return el('article', { class: 'finding' },
    el('p', { class: 'f-rank' }, `Rank ${r.rank}`),
    el('h3', null, link(r.name, () => openTarget({ kind: 'process', key: r.key }), '')),
    el('p', { class: 'f-fig' }, num(r.total, { after: ' a month', cls: 'big' }), ' · ', num(r.hours, { after: ' hours a month' })),
    el('div', { class: 'chain' },
      el('p', null, el('b', null, 'Where it stalls: '), f.stall_summary ?? stallLine(r)),
      el('p', null, el('b', null, 'What would fix it: '), f.fix === null ? 'no approach was proposed.' : [f.fix, ' ', el('span', { class: 'ours' }, '(our proposal)')]),
      el('p', null, el('b', null, 'Ready to use: '), docLine(r))),
    f.quote ? el('div', { class: 'f-quote' }, quoteBlock(f.quote, { counted_in: { process: r.name } })) : null);
}

function renderList() {
  const t = document.getElementById('rank-table');
  if (t === null) return;
  const all = inTotal();
  const rows = all.slice(0, listN);
  const rest = all.slice(listN);
  const H = D.headline;
  const foot = el('div', { class: 'more-line' },
    rest.length > 0
      ? el('span', null, link(`${plural(rest.length, 'more process', 'more processes')}`, () => go('all-processes')), ' take the running total to ', num(H.total, { after: ' a month' }), '.')
      : H.rows_below.v > 0 ? el('span', null, num(H.rows_below, { after: ' more' }), ' were seen too rarely to count (', num(H.below_cents, { after: ' a month' }), ', not in the total).') : null,
    rest.length > 0 ? el('button', {
      type: 'button',
      class: 'toggle',
      onclick: () => {
        listN += 10;
        renderList();
        // Keep the keyboard where it was: on the next "Show", or on the link to every process.
        /** @type {HTMLElement | null} */ (document.querySelector('#rank-table tr.more .toggle, #rank-table tr.more .link:last-child'))?.focus();
      },
    }, `Show the next ${grouped(Math.min(10, rest.length))}`) : null,
    link(`All ${grouped(D.rows.length)} processes`, () => go('all-processes')));
  fillTable(/** @type {HTMLElement} */ (t), rows, { full: false, foot, line: true });
}

/** The rank cell: the row's own rank, whatever the order. @param {any} row */
function rankCell(row) {
  return el('td', { class: 'r rk' }, String(row.rank));
}

/**
 * Fills a ranked table: the overview's few columns, or the full list's. The drafting line goes after
 * the last process with a document, in rank order only.
 * @param {HTMLElement} t @param {any[]} rows @param {{ full: boolean, foot?: Node | null, line: boolean, sort?: { key: string, dir: string }, onSort?: (key: string) => void }} o
 */
function fillTable(t, rows, o) {
  const full = o.full;
  const max = Math.max(1, ...D.rows.map((/** @type {any} */ r) => r.total.v));
  /** @param {string} key @param {string} text @param {string | null} cls @param {string} [sub] */
  const sortTh = (key, text, cls, sub) => {
    const sorted = o.sort && o.sort.key === key;
    return el('th', { class: cls, scope: 'col', 'aria-sort': sorted ? o.sort?.dir : null },
      o.onSort ? el('button', { type: 'button', class: 'sortbtn', onclick: () => o.onSort?.(key) }, text) : text,
      sub ? el('span', { class: 'th-sub' }, sub) : null);
  };
  const headRow = el('thead', null, el('tr', null,
    sortTh('rank', 'Rank', 'r'),
    sortTh('name', 'Process', null),
    sortTh('total', 'Could be automated', 'r', 'dollars a month'),
    full ? sortTh('range', 'Range', 'r', 'low to high estimate') : null,
    sortTh('hours', 'Hours', 'r', 'a month'),
    full ? sortTh('seen', 'Seen', 'r') : null,
    th('Where it stalls'),
    th('Document'),
    th('Running total', 'r')));
  const body = el('tbody');
  const lastDrafted = D.chart.drafted;
  const lineKey = lastDrafted > 0 ? inTotal()[lastDrafted - 1]?.key : undefined;
  const cols = full ? 9 : 7;
  rows.forEach((r) => {
    body.append(tableRow(r, max, full));
    if (o.line && lineKey !== undefined && r.key === lineKey) {
      const n = draftedRows().length;
      body.append(el('tr', { class: 'thr' }, el('td', { colspan: cols }, el('div', { class: 'thr-box' }, swatch('line'),
        el('div', null, el('b', null, `Documents drafted for the ${n === 1 ? 'one' : grouped(n)} above this line. `), D.sentences.threshold, ' ',
          link('How we chose', () => goMethod('threshold')))))));
    }
  });
  if (o.foot) body.append(el('tr', { class: 'more' }, el('td', { colspan: cols }, o.foot)));
  t.replaceChildren(headRow, body);
  if (selKey) t.querySelectorAll('tr.row').forEach((x) => x.getAttribute('data-k') === selKey && x.classList.add('is-sel'));
}

/** @param {any} r @param {number} max @param {boolean} full */
function tableRow(r, max, full) {
  const scale = (full ? 110 : 150) / max;
  const c = CUM.get(r.key);
  const doc = r.document;
  /** @type {HTMLElement | null} */
  let nameBtn = null;
  const open = () => {
    remember(nameBtn);
    openTarget({ kind: 'process', key: r.key });
  };
  nameBtn = el('button', {
    type: 'button',
    class: 'pname',
    onclick: (/** @type {MouseEvent} */ ev) => {
      ev.stopPropagation();
      open();
    },
  }, r.name);
  const tr = el('tr', { class: `row${r.in_total ? '' : ' cbar'}`, 'data-k': r.key },
    rankCell(r),
    el('td', { class: 'pcell' }, nameBtn, el('span', { class: 'seen-in' }, r.in_total ? r.seen_in : `${cap(r.tier_words)} · ${r.seen_in}`)),
    el('td', { class: 'r' }, el('div', { class: 'amt' },
      el('span', { class: 'bar', 'aria-hidden': 'true', title: `${r.counted.t} counted + ${r.estimated.t} estimated` },
        el('i', { class: 'bc', style: { width: `${Math.max(0.5, r.counted.v * scale).toFixed(1)}px` } }),
        r.estimated.v > 0 ? el('i', { class: 'be', style: { width: `${(r.estimated.v * scale).toFixed(1)}px` } }) : null),
      num(r.total, { label: `${r.total.t} a month: ${r.counted.t} counted plus ${r.estimated.t} estimated. Opens how it is worked out.` }))),
    full ? el('td', { class: 'r' }, r.estimate === null ? el('span', { class: 'muted' }, 'no estimate') : [num(r.low), ' to ', num(r.high)]) : null,
    el('td', { class: 'r' }, num(r.hours)),
    full ? el('td', { class: 'r' }, num(r.occurrences), el('span', { class: 'sub' }, num(r.active_months))) : null,
    el('td', { class: 'stallk', title: r.stall_summary ?? null }, r.stall_label),
    el('td', { class: 'docstat' }, doc !== null && doc.status === 'done'
      ? el('span', null, linkTo(DOC_TITLE[doc.type] ?? doc.type, { kind: 'document', key: r.key }), doc.blanks ? el('span', { class: 'sub' }, num(doc.blanks, { after: ' to confirm' })) : null)
      : el('span', { class: 'muted docwhy' }, r.status_line)),
    el('td', { class: 'r runsub' }, c ? [num(c.cents), ' · ', num(c.share)] : el('span', { class: 'muted' }, 'not in the total')));
  tr.addEventListener('click', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button')) return;
    open();
  });
  tr.addEventListener('mouseenter', () => {
    if (r.in_total) setHot(r.key);
  });
  tr.addEventListener('mouseleave', () => setHot(null));
  return tr;
}

function nextSteps() {
  return el('ol', { class: 'next' }, D.next_steps.map((/** @type {any} */ s) => {
    const kinds = s.nums.map((/** @type {Num} */ n) => `${n.d.kind}:${n.d.filter ?? ''}`);
    return el('li', null, el('b', null, s.title),
      el('p', null, ...withNums(s.text, s.nums),
        kinds.includes('rows:drafted_one_mailbox') ? [' ', link('Where this comes from', () => openTarget({ kind: 'mailbox' }))] : null,
        kinds.includes('loops:') ? [' ', link('Open loops', () => go('open-loops'))] : null));
  }));
}

// ---- All processes ----

let sortState = { key: 'rank', dir: 'ascending' };

function renderAll() {
  const H = D.headline;
  const tiers = ['A', 'B', 'C'].map((t) => D.rows.find((/** @type {any} */ r) => r.tier === t)).filter(Boolean);
  const t = el('table', { class: 'rank is-full' });
  const v = $('#all-processes');
  v.replaceChildren(
    el('div', { class: 'view-head' },
      el('p', { class: 'kicker' }, 'All processes'),
      el('h2', null, `All ${grouped(D.rows.length)} recurring processes, ranked`),
      el('p', { class: 'lede' }, 'Ranked by what could be automated, in dollars a month; ties by name. The ', num(H.rows_in_total), ' in the ', num(H.total), ' total come first. ',
        H.rows_below.v > 0 ? [num(H.rows_below), ' were seen too rarely to count; they follow, marked, outside the total. '] : null,
        'Sorting by another column reorders the rows and keeps each one’s rank.')),
    el('div', { class: 'rankkey' },
      el('span', null, swatch('counted'), 'counted from the emails'), el('span', null, swatch('estimated'), 'estimated from the emails'),
      link('How to read these numbers', () => openTarget({ kind: 'method', section: 'explainer' }))),
    el('div', { class: 'tablewrap' }, t),
    el('div', { class: 'tierrule' }, el('p', { class: 'sub-h' }, 'The counting bar'),
      tiers.map((/** @type {any} */ r) => el('p', null, cap(r.tier_words), '.'))));
  const fill = () => fillTable(t, sortRows(D.rows, sortState.key, /** @type {any} */ (sortState.dir)), {
    full: true,
    line: sortState.key === 'rank' && sortState.dir === 'ascending',
    sort: sortState,
    onSort: (key) => {
      const start = /** @type {Record<string, string>} */ (SORTS)[key] ?? 'ascending';
      sortState = { key, dir: sortState.key === key ? (sortState.dir === 'ascending' ? 'descending' : 'ascending') : start };
      fill();
      /** @type {HTMLElement | null} */ (t.querySelector('th[aria-sort] .sortbtn'))?.focus();
    },
  });
  fill();
}

// ---- Open loops ----

/** @param {boolean} showAll */
function renderLoops(showAll, focusToggle = false) {
  const v = $('#open-loops');
  v.replaceChildren(el('p', { class: 'loading', role: 'status' }, 'Loading the open loops…'));
  loadLoops().then((L) => {
    const recent = L.filter((/** @type {any} */ l) => l.recent);
    const items = showAll ? L : recent;
    const lede = el('p', { class: 'lede' }, 'A thread is listed when its last message in the archive is a chase, or says it is waiting for an answer, and falls in the last 90 days of that mailbox’s record. ',
      D.sentences.no_reply, ' Grouped by process. Older threads that match the same rule count as stalls on each process page.');
    const toggle = el('button', {
      type: 'button',
      class: 'toggle',
      onclick: () => renderLoops(!showAll, true),
    }, showAll ? `Show the ${grouped(recent.length)} in the last 90 days` : `Show all ${grouped(L.length)} threads the rule matches`);
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    /** @type {any[]} */
    const loose = [];
    for (const l of items) {
      const k = l.processes[0];
      if (k === undefined || !ROWS.has(k)) loose.push(l);
      else groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    const keys = [...groups.keys()].sort((a, b) => (rowOf(a)?.rank ?? 1e9) - (rowOf(b)?.rank ?? 1e9));
    v.replaceChildren(
      el('div', { class: 'view-head' },
        el('p', { class: 'kicker' }, 'Open loops'),
        el('h2', null, `${plural(recent.length, 'thread was', 'threads were')} still waiting on someone when their mailbox’s record stops`),
        lede,
        el('div', { class: 'view-tools' }, showAll ? `Showing all ${grouped(L.length)} threads the rule matches, newest first within each process.` : `Showing the ${grouped(recent.length)} in the last 90 days of a mailbox’s record.`, toggle)),
      loopLanes(recent),
      el('div', null, keys.map((k) => {
        const r = rowOf(k);
        const ls = /** @type {any[]} */ (groups.get(k));
        return el('section', { class: 'loopgroup' },
          el('h3', null, link(r ? r.name : k, () => openTarget({ kind: 'process', key: k }), 'loop-subj'), el('span', { class: 'muted' }, `Rank ${r ? r.rank : ''} · ${plural(ls.length, 'open loop')}`)),
          loopList(ls, { from: k, markRecent: showAll }));
      }),
      loose.length === 0 ? null : el('section', { class: 'loopgroup' },
        el('h3', null, 'Not tied to a process', el('span', { class: 'muted' }, plural(loose.length, 'open loop'))),
        loopList(loose, { markRecent: showAll }))));
    if (focusToggle) /** @type {HTMLElement | null} */ (v.querySelector('.view-tools .toggle'))?.focus();
  }, (err) => {
    rendered.delete('open-loops');
    v.replaceChildren(el('p', { class: 'note' }, `The open loops did not load (${err instanceof Error ? err.message : String(err)}). Reload the page; if it still fails, run node obs.mjs build.`));
  });
}

/** One lane per mailbox: its record, its last 90 days shaded, a dot per recent open loop.
 * @param {any[]} recent */
function loopLanes(recent) {
  const mbs = D.scope.mailboxes;
  // From the first of the month four months before the earliest end (the 90 days and a margin) to
  // the first of the month after the latest end.
  const endMonths = mbs.map((/** @type {any} */ m) => String(m.last_utc).slice(0, 7)).sort();
  const startYm = prevMonth(prevMonth(prevMonth(prevMonth(endMonths[0] ?? '2000-01'))));
  const stopYm = nextMonth(endMonths.at(-1) ?? '2000-01');
  const lo = dayNumber(`${startYm}-01`) ?? 0;
  const hi = dayNumber(`${stopYm}-01`) ?? lo + 1;
  /** @param {number} d */
  const xp = (d) => Math.max(0, Math.min(100, ((d - lo) / Math.max(1, hi - lo)) * 100));
  const lanes = mbs.map((/** @type {any} */ mb) => {
    const end = dayNumber(mb.last_utc) ?? hi;
    const first = dayNumber(mb.first_utc) ?? lo;
    const items = recent.filter((l) => l.mailbox === mb.key);
    return el('div', { class: 'lane' },
      el('div', { class: 'lane-top' }, el('b', null, mb.owner), el('span', null, `record ${dateText(mb.first_utc)} to ${dateText(mb.last_utc)} · ${plural(items.length, 'open loop')}`)),
      el('div', { class: 'lane-track' },
        el('span', { class: 'lane-win', style: { left: `${xp(end - 90).toFixed(2)}%`, width: `${(xp(end) - xp(end - 90)).toFixed(2)}%` } }),
        el('span', { class: 'lane-line', style: { left: `${xp(first).toFixed(2)}%`, width: `${(xp(end) - xp(first)).toFixed(2)}%` } }),
        el('span', { class: 'lane-end', style: { left: `${xp(end).toFixed(2)}%` } }),
        items.map((l) => el('button', {
          type: 'button',
          class: `dot${l.why === 'chase' ? '' : ' is-wait'}`,
          style: { left: `${xp(dayNumber(l.date_utc) ?? end).toFixed(2)}%` },
          'aria-label': `${dateText(l.date_utc)}, ${nameOf(l.processes[0] ?? '')}: ${l.subject || 'no subject'}. ${l.why === 'chase' ? 'A chase' : 'Waiting for an answer'}. Opens the message.`,
          title: `${dateText(l.date_utc)} · ${nameOf(l.processes[0] ?? '')}`,
          onclick: (/** @type {MouseEvent} */ ev) => {
            remember(/** @type {HTMLElement} */ (ev.currentTarget));
            openTarget({ kind: 'message', id: l.message_id }, { quote: l.quote ?? undefined });
          },
        }))));
  });
  /** @type {Kid[]} */
  const ticks = [];
  for (let ym = nextMonth(startYm); ym < stopYm; ym = nextMonth(ym)) {
    const x = xp(dayNumber(`${ym}-15`) ?? hi);
    ticks.push(el('span', { style: { left: `${x.toFixed(2)}%` } }, ym.endsWith('-01') ? `${MONTHS[0]} ${ym.slice(0, 4)}` : MONTHS[Number(ym.slice(5, 7)) - 1] ?? ''));
  }
  return el('div', { class: 'lanes' }, lanes,
    el('div', { class: 'lane-axis', 'aria-hidden': 'true' }, ticks),
    el('div', { class: 'lane-key' },
      el('span', null, el('i', { class: 'kdot' }), 'a chase'),
      el('span', null, el('i', { class: 'kdot is-wait' }), 'waiting for an answer'),
      el('span', null, el('i', { class: 'kwin' }), 'last 90 days of the mailbox’s record')));
}

// ---- How we measured ----

function renderMethod() {
  const v = $('#methodology');
  v.replaceChildren(el('div', { class: 'view-head' },
    el('p', { class: 'kicker' }, 'How we measured'),
    el('h2', null, 'Methodology'),
    el('p', { class: 'lede' }, 'What is counted, what is estimated, and how the two become dollars. Every figure here comes from the run’s files; every list opens.')),
  el('p', { class: 'loading', role: 'status' }, 'Loading the methodology…'));
  loadMethod().then((M) => {
    v.replaceChildren(v.firstChild ?? '', methodBody(M));
    if (pendingSection !== null && currentView() === 'methodology') {
      scrollToSection();
      pendingSection = null;
    }
  }, (err) => {
    rendered.delete('methodology');
    pendingSection = null;
    v.replaceChildren(v.firstChild ?? '', el('p', { class: 'note' }, `The methodology did not load (${err instanceof Error ? err.message : String(err)}). Reload the page; if it still fails, run node obs.mjs build.`));
  });
}

/** @param {string} id @param {string} title @param {Kid[]} kids */
function methodSec(id, title, ...kids) {
  return el('section', { class: 'ol-sec', id: `method-${id}` }, el('h3', null, title), el('div', null, kids));
}

/** @param {string[]} lines */
const ul = (lines) => el('ul', null, lines.map((x) => el('li', null, x)));

/** @param {any} M */
function methodBody(M) {
  const H = D.headline;
  const R = D.rates;
  const cov = M.coverage;
  const id = M.identity;
  const run = M.run;
  /** @type {Kid[]} */
  const recon = [num(D.scope.files, { here: { kind: 'method', section: 'coverage' } }), ' = '];
  cov.forEach((/** @type {any} */ c, /** @type {number} */ i) => recon.push(i > 0 ? ' + ' : '', num(c.count), ` ${c.bucket}`));
  /** A count opening a list of addresses. @param {string} title @param {string[]} items */
  const addrList = (title, items) => link(`${grouped(items.length)} ${title}`, () => show(listLayer('People', `${cap(title)}: ${grouped(items.length)}`, [el('ul', { class: 'flags' }, items.map((x) => el('li', null, el('code', null, x))))])));
  return el('div', { class: 'outline' },
    methodSec('coverage', 'Every message, accounted for',
      el('p', { class: 'recon' }, recon),
      el('ul', null, cov.map((/** @type {any} */ c) => el('li', null, el('b', null, `${cap(c.bucket)}: `), c.words))),
      el('p', null, link('The process names proposed for unassigned mail', () => show(slugsLayer('unassigned'))), ' · ', link('The copies, by original', () => show(dedupLayer())))),
    methodSec('rates', 'Rates',
      el('p', null, num(R.hourly, { here: { kind: 'method', section: 'rates' } }), ' an hour, the brief’s blended rate, prices every minute.'),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Email action'), th('Minutes each', 'r'), th('Share that could be automated', 'r'))),
        el('tbody', null, ACTION_ORDER.map((t) => el('tr', null, el('td', null, ACTION_RATE_WORDS[t] ?? t), el('td', { class: 'r' }, String(R.minutes[t] ?? '')), el('td', { class: 'r' }, `${R.automatable_pct[t] ?? ''}%`)))))),
      el('p', { class: 'calc' }, `Reads are counted once per staff addressee, up to ${R.read_cap} a message. An email’s length is the sender’s own text: short up to ${grouped(R.buckets.short_max)} characters, medium up to ${grouped(R.buckets.medium_max)}, long beyond.`),
      el('p', { class: 'small' }, 'Rates file ', el('code', null, R.file), ' · sha256 ', el('span', { class: 'hash' }, R.sha)),
      el('p', { class: 'small' }, 'Scoring file ', el('code', null, D.scoring.file), ' · sha256 ', el('span', { class: 'hash' }, D.scoring.sha))),
    methodSec('tiers', 'The counting bar',
      ul(M.words.tiers),
      el('p', null, num(H.rows_in_total, { after: ' processes in the total' }), ' · ', num(H.rows_below, { after: ' seen too rarely to count' }))),
    methodSec('threshold', 'The drafting rule',
      ul(M.words.threshold),
      documentsTable()),
    methodSec('estimates', 'Estimates',
      ul(M.words.estimates),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Rank', 'r'), th('Process'), th('Minutes a round', 'r', 'low · middle · high'), th('Automatable', 'r'), th('Basis'), th('Cited', 'r', 'rounds · senders'), th('Set by'))),
        el('tbody', null, M.estimates.map((/** @type {any} */ e) => el('tr', null,
          el('td', { class: 'r' }, String(e.rank)),
          el('td', null, link(e.name, () => openTarget({ kind: 'process', key: e.key }))),
          el('td', { class: 'r' }, `${e.low} · ${e.mid} · ${e.high}`),
          el('td', { class: 'r' }, `${e.automatable_pct}%`),
          el('td', null, e.basis),
          el('td', { class: 'r' }, `${e.occurrences_cited} · ${e.senders_cited}`),
          el('td', null, e.source === 'override' ? `the project team (${e.override_file ?? 'a file'})` : 'the run'))))))),
    methodSec('rounding', 'Rounding', ul(M.words.rounding)),
    methodSec('identity', 'People',
      ul(M.words.identity),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Fold rule'), th('Folds', 'r'))),
        el('tbody', null, id.folds.map((/** @type {any} */ f) => el('tr', null, el('td', null, f.words),
          el('td', { class: 'r' }, num(f.count, {
            label: `${f.count.t} folds by the rule: ${f.words}. Opens the list.`,
            open: () => show(listLayer('People', `Folded by the rule: ${f.words}`, [el('ul', { class: 'flags' }, f.items.map((/** @type {any} */ x) => el('li', null, el('code', null, x.email), ' onto ', el('code', null, x.canonical), x.name ? ` (${x.name})` : '')))])),
          }))))))),
      el('p', null, 'Left apart: ',
        addrList('m..last addresses with several candidates', id.left_apart.ambiguous), ', ',
        addrList('with one candidate but no middle initial to confirm it', id.left_apart.no_initial), ', ',
        addrList('refused because the two share a message', id.left_apart.shared_message), ', ',
        addrList('with no candidate', id.left_apart.no_candidate), '.'),
      el('p', null, 'Never staff: ', addrList('distribution lists', id.lists), ' and ', addrList('system senders', id.system), '.')),
    methodSec('flagged', 'What was flagged',
      M.flagged.map((/** @type {any} */ x) => el('div', null,
        el('p', null, x.sentence, ' ', linkTo('Open the message', { kind: 'message', id: x.message_id }), '.'),
        pathLine(x.message_id),
        el('p', { class: 'small' }, `Found by its content: ${x.markers.map((/** @type {string} */ k) => k.replace(/_/g, ' ')).join('; ')}.`))),
      el('p', { class: 'sub-h', id: 'method-dates' }, `Messages without a usable date: ${grouped(M.dates.length)}`),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Message'), th('Date header as written'), th('Why it is not used'))),
        el('tbody', null, M.dates.map((/** @type {any} */ x) => el('tr', null,
          el('td', null, linkTo(x.message_id, { kind: 'message', id: x.message_id }, {}, 'link mono')),
          el('td', null, x.date_raw === null ? el('span', { class: 'muted' }, 'none') : el('code', null, x.date_raw)),
          el('td', null, x.words))))))),
    methodSec('merge', 'Merging the process names',
      el('p', null, M.merge.sentence),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Promoted process'), th('Names folded in', 'r'), th('Messages', 'r'), th('Rounds', 'r'), th('Months', 'r'))),
        el('tbody', null, M.merge.promoted.map((/** @type {any} */ p) => el('tr', null,
          el('td', null, ROWS.has(p.key) ? link(p.name, () => openTarget({ kind: 'process', key: p.key })) : p.name),
          el('td', { class: 'r', title: p.aliases.join(', ') }, grouped(p.aliases.length)),
          el('td', { class: 'r' }, grouped(p.messages)),
          el('td', { class: 'r' }, grouped(p.occurrences)),
          el('td', { class: 'r' }, grouped(p.active_months))))))),
      el('p', null, link(`Every name proposed while reading (${grouped(M.merge.slugs.length)})`, () => show(slugsLayer('all'))), ' · ',
        link(`The ${grouped(M.taxonomy.length)} starting processes`, () => show(listLayer('Merging the process names', 'The starting processes', [el('ul', { class: 'flags' }, M.taxonomy.map((/** @type {any} */ t) => el('li', null, el('b', null, t.name), `: ${t.definition}`)))]))))),
    methodSec('quotes', 'Quote checks',
      el('p', null, M.quotes.sentence),
      el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Quotes'), th('Exact', 'r'), th('Repaired', 'r'), th('Rejected', 'r'))),
        el('tbody', null, Object.entries(M.quotes.counts).map(([k, c]) => el('tr', null, el('td', null, cap(k)), el('td', { class: 'r' }, grouped(/** @type {any} */ (c).exact)), el('td', { class: 'r' }, grouped(/** @type {any} */ (c).repaired)), el('td', { class: 'r' }, grouped(/** @type {any} */ (c).rejected))))))),
      M.quotes.rejections.length > 0 ? el('ul', { class: 'flags' }, M.quotes.rejections.map((/** @type {any} */ x) => el('li', null, `${x.kind}: “${x.quote}” `, linkTo(x.message_id, { kind: 'message', id: x.message_id }, {}, 'link mono'), x.reason ? `: ${x.reason}` : ''))) : null,
      el('p', { id: 'method-gold' }, M.gold === null ? 'Gold set: not scored on this run.' : ['Gold set: ', M.gold.sentence, ' ',
        link(`The ${grouped(M.gold.mismatches.length)} that differ`, () => show(listLayer('Quote checks', 'Hand labels that differ', [el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
          el('thead', null, el('tr', null, th('Message'), th('Hand label'), th('The run'))),
          el('tbody', null, M.gold.mismatches.map((/** @type {any} */ x) => el('tr', null,
            el('td', null, linkTo(x.id, { kind: 'message', id: x.id }, {}, 'link mono')),
            el('td', null, `${x.label.processes.join(', ') || 'none'} (${x.label.role})`),
            el('td', null, `${x.extracted.processes.join(', ') || 'none'} (${x.extracted.role})`))))))])))])),
    methodSec('run', 'Run facts',
      el('p', null, 'Run ', el('code', null, run.id ?? 'none'), run.later_runs.length > 0 ? [', continued in ', num(D.run.later_runs, { here: { kind: 'method', section: 'run' } }), ` later ${run.later_runs.length === 1 ? 'run' : 'runs'} (`, run.later_runs.map((/** @type {any} */ x, /** @type {number} */ i) => [i > 0 ? ', ' : '', el('code', null, x.id)]), ')'] : '', '.'),
      run.minutes ? el('p', null, num(run.minutes, { after: ' minutes', here: { kind: 'method', section: 'run' } }), ' of run time, from each run’s first event to its last step of work.') : null,
      el('p', null, `Agents launched: ${run.agents.length === 0 ? 'none' : run.agents.map((/** @type {any} */ a) => `${grouped(a.count)} ${a.type}`).join(', ')}.`,
        ` Fix rounds: ${run.fix_rounds.length === 0 ? 'none' : run.fix_rounds.map((/** @type {any} */ x) => `${x.job} ${grouped(x.rounds)}`).join(', ')}.`),
      run.stages.length > 0 ? el('div', { class: 'tw' }, el('table', { class: 'mini-t' },
        el('thead', null, el('tr', null, th('Step'), th('Milliseconds', 'r'), th('What it said'))),
        el('tbody', null, run.stages.map((/** @type {any} */ s) => el('tr', null, el('td', null, s.name), el('td', { class: 'r' }, grouped(s.ms)), el('td', null, s.summary)))))) : null,
      el('p', { class: 'small' }, 'Run log: ', run.log ? el('code', null, run.log) : 'none', run.later_runs.map((/** @type {any} */ x) => [', ', el('code', null, x.log)]))));
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

const THEME_KEY = 'obs-dashboard-theme';
/** @param {string} t */
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  const b = document.getElementById('theme');
  if (b) {
    b.textContent = `Theme: ${t}`;
    b.setAttribute('aria-label', `Theme: ${t}. ${t === 'system' ? 'Follows the system colour setting; select to change.' : 'Select to change.'}`);
  }
}

function initTheme() {
  let t = 'system';
  try {
    t = localStorage.getItem(THEME_KEY) ?? 'system';
  } catch {
    t = 'system';
  }
  if (!THEMES.includes(/** @type {any} */ (t))) t = 'system';
  applyTheme(t);
  document.getElementById('theme')?.addEventListener('click', () => {
    t = nextTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // A private window or blocked storage: the choice lasts until the page closes.
    }
  });
}

function wireShell() {
  // A double click opens the drawer on its first click; its second must not close it again from the
  // scrim, or press whatever the new layer put under the pointer.
  $('#scrim').addEventListener('click', () => {
    if (performance.now() - openedAt >= 400) closeDrawer();
  });
  document.addEventListener('click', (ev) => {
    if (ev.detail > 1 && performance.now() - renderedAt < 500 && ev.target instanceof Node && (drawer().contains(ev.target) || ev.target === $('#scrim'))) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    // Whatever was clicked inside the drawer (the viewer's own links included) is where Back returns.
    const b = ev.target instanceof Element ? ev.target.closest('button, a') : null;
    if (b instanceof HTMLElement && drawer().contains(b)) remember(b);
  }, true);
  $('#d-close').addEventListener('click', closeDrawer);
  $('#d-back').addEventListener('click', back);
  $('#nav-lookup').addEventListener('click', (ev) => {
    remember(/** @type {HTMLElement} */ (ev.currentTarget));
    openRoot(lookupLayer());
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      back();
      return;
    }
    if (ev.key === 'Tab') {
      const f = [...drawer().querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter((x) => x instanceof HTMLElement && !x.hidden && x.offsetParent !== null);
      if (f.length === 0) return;
      const first = /** @type {HTMLElement} */ (f[0]);
      const last = /** @type {HTMLElement} */ (f[f.length - 1]);
      const active = document.activeElement;
      if (ev.shiftKey && (active === first || !drawer().contains(active))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (active === last || !drawer().contains(active))) {
        ev.preventDefault();
        first.focus();
      }
    }
  });
  // Browser Back or Forward changes the view: the drawer, which belongs to the view it opened on, closes.
  window.addEventListener('hashchange', () => {
    const wasOpen = isOpen();
    if (wasOpen) closeDrawer();
    applyView();
    // The opener belonged to the view just left: the focus goes to the new view's heading.
    if (wasOpen) {
      const h = document.querySelector(`#${currentView()} h2`);
      if (h instanceof HTMLElement) {
        h.setAttribute('tabindex', '-1');
        h.focus({ preventScroll: true });
      }
    }
  });
  let frame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawCharts);
  });
  document.fonts?.ready.then(() => drawCharts());
}

function renderShell() {
  const mbs = D.scope.mailboxes;
  const title = `Recurring work in ${numberWord(mbs.length)} ${mbs.length === 1 ? 'mailbox' : 'mailboxes'}`;
  document.title = title;
  $('#title').textContent = title;
  const runline = $('#runline');
  runline.replaceChildren();
  add(runline, [D.run.date === null ? 'No run log' : `Run of ${dateText(D.run.date)}`, ' · ', num(D.scope.files, { after: ' messages read' }), ' · rates at ', num(D.rates.hourly), ' an hour']);
  const foot = $('#footer');
  foot.replaceChildren();
  add(foot, [
    el('p', null, 'Run ', el('code', null, D.run.id ?? 'none'),
      D.run.later_runs && D.run.later_runs.v > 0 ? [', continued in ', num(D.run.later_runs), ` later ${D.run.later_runs.v === 1 ? 'run' : 'runs'}`] : null,
      D.run.date ? ` · ${dateText(D.run.date)}` : '', ' · ', num(D.scope.files, { after: ' messages' }), ' · ', num(D.rates.hourly), ' an hour.'),
    el('p', null, 'Counted: email actions found in the messages, priced at published minutes per action. Estimated: the hands-on work behind each round, estimated once per process from cited emails and checked by code.'),
    el('p', null, `Prepared for Enron from ${numberWord(mbs.length)} employees’ archived mail. `, el('a', { href: 'report.html', class: 'link' }, 'The same figures as a printable report'), '.'),
  ]);
}

/** The page's data: data.json, indexed by process key, mailbox and running-total step. Exported
 * so the tests can render with a built fixture. @param {any} data */
export function useData(data) {
  D = data;
  ROWS.clear();
  MAILBOX.clear();
  CUM.clear();
  for (const r of D.rows) ROWS.set(r.key, r);
  for (const m of D.scope.mailboxes) MAILBOX.set(m.key, m);
  for (const c of D.cumulative) CUM.set(c.key, c);
}

async function boot() {
  initTheme();
  wireShell();
  try {
    useData(await loadJSON('data.json'));
  } catch (err) {
    $('#overview').replaceChildren(el('p', { class: 'note' }, `The dashboard data did not load (${err instanceof Error ? err.message : String(err)}). Run node obs.mjs build after a complete run, then node obs.mjs serve, and reload.`));
    return;
  }
  renderShell();
  renderOverview();
  applyView();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('overview') !== null) void boot();
