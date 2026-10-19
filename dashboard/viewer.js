// @ts-check
// The message viewer and the drafted-document renderer (ARCHITECTURE.md 6.13). A plain ES module
// with no dependencies: app.js imports it, and the tests import it in Node, so nothing at the top
// level touches the DOM; the document is read inside the functions (useDocument sets one for the
// tests). Every string that came from an email or a model is put on the page as a text node through
// el(); nothing here parses HTML or sets a style attribute (the server's CSP allows neither).
//
// Exports:
//   el(tag, props, ...kids), add(node, kids), useDocument(doc)   building nodes
//   copyButton(text, label, target), pathLine(id)                the copyable message id
//   fetchMessage(id)                                             GET /api/message, for api.fetchMessage
//   staticMessagePath(id)                                        a message's file in the site's static copy
//   messageView(host, api, opts)                                 the viewer, rendered into host
//   lookupForm(api, opts)                                        "Paste a message ID", Open
//   renderMarkdown(md, hooks)                                    a drafted document, as nodes
//   splitForMark(text, start, end), needsLoadAll(text), lazyCut(text, minEnd), LAZY   for the tests
//
// Class names the page styles: layer-kicker, layer-title mono, msg-actions, copy (is-done), cmd,
// note, note flag, msg-meta, label, raw, quote-mark, more, btn, link mono msg, lookup, small, path,
// blank.

/**
 * @typedef {{ id: string, mailbox: string, folder: string, date_utc: string | null, date_status: string,
 *   from: string, from_name: string | null, subject: string, recipients: number, thread_id: string | null,
 *   occurrence_id: string | null, duplicate_of: string | null, role: string | null, processes: string[],
 *   flags: string[] }} IndexRow
 * @typedef {{ id: string, size: number, blob_sha: string, text: string, source: string }} MessageText
 * @typedef {{ id: string, kind: string, message_id: string, start: number, end: number, raw_text: string,
 *   match: string, segment: string | null, field: string, sender: string, sender_label: string,
 *   date_utc: string | null }} QuoteRef
 * @typedef {Map<string, IndexRow> | IndexRow[]} IndexLike
 * @typedef {{
 *   fetchMessage: (id: string) => Promise<MessageText>,
 *   index?: IndexLike | (() => IndexLike | Promise<IndexLike>),
 *   rates?: { minutes: Record<string, number>, automatable_pct: Record<string, number> },
 *   processName?: (key: string) => string | undefined,
 *   mailboxOwner?: (key: string) => string | undefined,
 *   open?: (id: string) => void,
 * }} ViewerApi
 * @typedef {{ id: string, quote?: QuoteRef | null, action?: string | null,
 *   counted_in?: { process?: string, by?: string } | null, titleId?: string }} ViewOptions
 * @typedef {{ ids?: { has: (id: string) => boolean }, onMessageId?: (id: string) => void, base?: number }} MarkdownHooks
 * @typedef {string | number | Node | null | undefined | false | Kid[]} Kid
 */

// ---- Building nodes ----

/** @type {Document | null} */
let current = null;

/** A document to build with (the tests pass a small shim); null goes back to the page's. @param {Document | null} d */
export function useDocument(d) {
  current = d;
}

/** @returns {Document} */
function doc() {
  const d = current ?? globalThis.document;
  if (d === undefined || d === null) throw new Error('viewer.js: no document to build with');
  return d;
}

// Attributes that take a URL never get a script or data URL.
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const UNSAFE_URL = /^(?:javascript|vbscript|data):/i;
// A URL as a browser reads its scheme: control characters and spaces dropped (it strips them at the
// ends and ignores tabs and line breaks inside, so "java\tscript:" is javascript:).
/** @param {string} url */
const schemeText = (url) => url.replace(/[\u0000- \u007f-\u009f]/g, '');

/** Append kids to n: strings and numbers as text nodes, arrays flattened, null and false skipped.
 * @template {Node} N @param {N} n @param {Kid[]} kids @returns {N} */
export function add(n, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(n, c);
    else n.appendChild(typeof c === 'string' || typeof c === 'number' ? doc().createTextNode(String(c)) : c);
  }
  return n;
}

/**
 * An element: "class" as its class name, "style" as an object set through the CSSOM, "on<event>"
 * functions as listeners, everything else as attributes; children as text nodes or nodes.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {Kid[]} kids
 * @returns {HTMLElement}
 */
export function el(tag, props, ...kids) {
  const n = doc().createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = String(v);
      else if (k === 'style') {
        if (typeof v !== 'object') throw new TypeError('el: style takes an object of properties, set through the CSSOM');
        for (const [p, val] of Object.entries(/** @type {Record<string, unknown>} */ (v))) n.style.setProperty(p.startsWith('--') ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(val));
      } else if (k.startsWith('on')) {
        if (typeof v !== 'function') throw new TypeError(`el: ${k} takes a function`);
        n.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
      } else {
        const text = v === true ? '' : String(v);
        if (URL_ATTRIBUTES.has(k.toLowerCase()) && UNSAFE_URL.test(schemeText(text))) throw new TypeError(`el: refused a script or data URL in ${k}`);
        n.setAttribute(k, text);
      }
    }
  }
  return add(n, kids);
}

// ---- Copying ----

/**
 * A button that copies the text and says so for a moment, then shows its label again; without the
 * clipboard it selects the target for the reader to copy. The label is kept from the start, so a
 * second click while the button still says "Copied" cannot make that its label.
 * @param {string} text @param {string} label @param {Node | null} [target]
 */
export function copyButton(text, label, target = null) {
  const b = el('button', { type: 'button', class: 'copy', 'aria-label': `${label}: ${text}` }, label);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @param {string} shown @param {boolean} copied @param {number} ms */
  const show = (shown, copied, ms) => {
    clearTimeout(timer);
    b.textContent = shown;
    if (copied) b.classList.add('is-done');
    else b.classList.remove('is-done');
    timer = setTimeout(() => {
      b.textContent = label;
      b.classList.remove('is-done');
    }, ms);
  };
  const select = () => {
    const sel = globalThis.getSelection?.();
    if (target && sel) {
      const range = doc().createRange();
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    show('Selected: press Ctrl+C (Cmd+C on a Mac)', false, 2200);
  };
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    try {
      const clip = globalThis.navigator?.clipboard;
      if (clip && typeof clip.writeText === 'function') clip.writeText(text).then(() => show('Copied', true, 1400), select);
      else select();
    } catch {
      select();
    }
  });
  return b;
}

/** The path line under a quote or a message: the id in <code>, trailing dot included, and Copy.
 * @param {string} id */
export function pathLine(id) {
  const code = el('code', { title: 'Message ID, trailing dot included' }, id);
  return el('span', { class: 'path' }, code, copyButton(id, 'Copy', code));
}

// ---- Words and small formats (no number here is a reported figure) ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1,371": digits grouped for reading. @param {number} n */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "12 Jun 2001, 17:59 UTC" from the stored UTC string, read by its parts (never parsed as a date).
 * @param {string | null} utc */
function dateTimeText(utc) {
  const m = utc === null ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(utc);
  if (m === null) return 'no usable date';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}, ${m[4]}:${m[5]} UTC`;
}

/** "Giron, Darron C" read as "Darron C Giron"; no name: the address. @param {string | null} name @param {string} email */
function personName(name, email) {
  if (name === null || name.trim() === '') return email === '' ? 'unknown sender' : email;
  const m = /^([^,]+),[ \t]*([^,]+)$/.exec(name.trim());
  const s = m === null ? name.trim() : `${(m[2] ?? '').trim()} ${(m[1] ?? '').trim()}`;
  return s.replace(/[ \t]+[–—][ \t]+/g, ', ').replace(/[–—]/g, '-');
}

/** @type {Record<string, string>} */
const ROLE_WORDS = {
  request: 'a request',
  response: 'a reply',
  forward: 'a forward',
  fyi: 'for information',
  automated: 'an automated message',
  personal: 'personal mail',
  noise: 'not about the work',
  injection_attempt: 'addressed to an automated reviewer',
};

/** @type {Record<string, string>} */
const ACTION_WORDS = {
  authored_short: 'a short email written',
  authored_medium: 'a medium email written',
  authored_long: 'a long email written',
  forward: 'a forward',
  chaser: 'a chaser',
  read: 'reads by its staff addressees',
  authored: 'an email written',
};

/** @type {Record<string, string>} */
const SEGMENT_WORDS = { quoted: ', inside quoted text', forwarded: ', inside forwarded text', subject: ', in the subject line' };

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${grouped(n)} ${n === 1 ? one : many}`;

// ---- The raw text, marked and loaded lazily ----

// Over this many characters a message shows its first lines and a "Load all" button.
export const LAZY = Object.freeze({ chars: 32000, lines: 1200 });

/** Whether a message is long enough to load in two parts. @param {string} text */
export function needsLoadAll(text) {
  return text.length > LAZY.chars;
}

/**
 * Where the first part of a long message stops: after its first LAZY.lines lines, or after the line
 * holding minEnd (a quote's end) when that is later. The whole text when it is short.
 * @param {string} text @param {number} [minEnd]
 */
export function lazyCut(text, minEnd = 0) {
  if (!needsLoadAll(text)) return text.length;
  let cut = text.length;
  let at = -1;
  for (let line = 0; line < LAZY.lines; line++) {
    at = text.indexOf('\n', at + 1);
    if (at === -1) break;
  }
  if (at !== -1) cut = at + 1;
  if (minEnd > cut) {
    const nl = text.indexOf('\n', Math.max(0, minEnd - 1));
    cut = nl === -1 ? text.length : nl + 1;
  }
  return cut;
}

/**
 * The text around a stored span, split at its offsets (UTF-16 units of the decoded message, end
 * exclusive): the viewer marks text.slice(start, end) and never searches. Null when the offsets do
 * not fit the text.
 * @param {string} text @param {number} start @param {number} end
 * @returns {{ before: string, mark: string, after: string } | null}
 */
export function splitForMark(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return null;
  return { before: text.slice(0, start), mark: text.slice(start, end), after: text.slice(end) };
}

// ---- The message index ----

/** @type {WeakMap<object, Map<string, IndexRow>>} */
const asMaps = new WeakMap();
/** @type {WeakMap<Map<string, IndexRow>, Map<string, string[]>>} */
const copiesOf = new WeakMap();

/** The index as a Map by id, whatever form the page holds it in; null when it gives none.
 * @param {ViewerApi} api @returns {Promise<Map<string, IndexRow> | null>} */
async function indexOf(api) {
  const ix = typeof api.index === 'function' ? await api.index() : api.index;
  if (ix instanceof Map) return ix;
  if (!Array.isArray(ix)) return null;
  let m = asMaps.get(ix);
  if (m === undefined) {
    m = new Map(ix.map((r) => [r.id, r]));
    asMaps.set(ix, m);
  }
  return m;
}

/** The other copies of a message: its original and the duplicates of that original, by id.
 * @param {Map<string, IndexRow>} index @param {IndexRow} row */
function otherCopies(index, row) {
  let by = copiesOf.get(index);
  if (by === undefined) {
    by = new Map();
    for (const r of index.values()) {
      if (r.duplicate_of === null) continue;
      const list = by.get(r.duplicate_of) ?? [];
      list.push(r.id);
      by.set(r.duplicate_of, list);
    }
    for (const list of by.values()) list.sort();
    copiesOf.set(index, by);
  }
  const original = row.duplicate_of ?? row.id;
  return { original, copies: (by.get(original) ?? []).filter((id) => id !== row.id) };
}

/**
 * Where the static copy of the dashboard keeps one message, relative to its page: the id after
 * "corpus/", one trailing dot dropped, ".json" added, under m/, each segment URL-encoded, so
 * corpus/farmer-d/logistics/1. is m/farmer-d/logistics/1.json. site/dashboard.ts writes the files by
 * this rule. An id the server would refuse throws "not a message id", as the server answers.
 * @param {string} id
 */
export function staticMessagePath(id) {
  if (!id.startsWith('corpus/') || id.includes('..') || id.includes('\\') || /^[A-Za-z]:/.test(id) || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('not a message id');
  return `m/${`${id.slice('corpus/'.length).replace(/\.$/, '')}.json`.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * One message as MessageText; throws with the server's own reason. From the dashboard server: GET
 * /api/message. From the static copy on the project site (its <html> carries data-static="1"): the
 * file staticMessagePath names, beside the page.
 * @param {string} id @returns {Promise<MessageText>}
 */
export async function fetchMessage(id) {
  if ((current ?? globalThis.document)?.documentElement?.dataset?.static === '1') {
    const path = staticMessagePath(id);
    /** @type {Response} */
    let got;
    try {
      got = await fetch(path);
    } catch {
      // Not a TypeError: the viewer's hint about restarting the local server does not apply here.
      throw new Error('the site did not answer');
    }
    // A missing file is the host's own 404 page, not JSON.
    if (!got.ok) throw new Error(got.status === 404 ? 'no message with this id' : `status ${got.status}`);
    /** @type {unknown} */
    let copy = null;
    try {
      copy = await got.json();
    } catch {
      copy = null;
    }
    if (copy === null || typeof copy !== 'object' || typeof (/** @type {{ text?: unknown }} */ (copy).text) !== 'string') throw new Error('the site’s copy of it is damaged');
    // The file of another id ("1" without its dot, or a "./" in the path, lands on 1.'s file): the
    // server looks an id up exactly, so this is its 404.
    if (/** @type {{ id?: unknown }} */ (copy).id !== id) throw new Error('no message with this id');
    return /** @type {MessageText} */ (copy);
  }
  const res = await fetch(`/api/message?id=${encodeURIComponent(id)}`);
  /** @type {unknown} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason = body !== null && typeof body === 'object' && 'error' in body ? String(/** @type {{ error: unknown }} */ (body).error) : `status ${res.status}`;
    throw new Error(reason);
  }
  return /** @type {MessageText} */ (body);
}

// ---- Opening another message ----

/** @param {ViewerApi} api @param {Element | null} host @param {string} id @param {string | undefined} titleId */
function openMessage(api, host, id, titleId) {
  if (typeof api.open === 'function') api.open(id);
  else if (host !== null) void messageView(host, api, { id, titleId });
}

/** A text-styled button. @param {string} text @param {() => void} onClick @param {string} [cls] */
function linkButton(text, onClick, cls = 'link') {
  return el('button', {
    type: 'button',
    class: cls,
    onclick: (/** @type {Event} */ ev) => {
      ev.stopPropagation();
      onClick();
    },
  }, text);
}

/** An id as the reader pasted it: spaces, one pair of quotes or backticks around it, and Windows
 * backslashes taken off. @param {string} s */
function cleanId(s) {
  let id = s.trim();
  const pair = /^(["'`])(.*)\1$/.exec(id);
  if (pair) id = (pair[2] ?? '').trim();
  return id.replace(/\\/g, '/');
}

/**
 * The lookup form: a text input and Open; the hint for an id without its trailing dot.
 * @param {ViewerApi} api
 * @param {{ prefill?: string, placeholder?: string, host?: Element | null, titleId?: string }} [opts]
 */
export function lookupForm(api, opts = {}) {
  const input = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Message ID',
    placeholder: opts.placeholder ?? 'corpus/<mailbox>/<folder>/<number>.',
  }));
  if (opts.prefill) input.value = opts.prefill;
  const msg = el('p', { class: 'small', 'aria-live': 'polite' });
  const form = el('form', {
    class: 'lookup',
    onsubmit: async (/** @type {Event} */ ev) => {
      ev.preventDefault();
      const id = cleanId(input.value);
      if (id === '') {
        msg.replaceChildren('Paste a message ID, trailing dot included.');
        return;
      }
      /** @type {Map<string, IndexRow> | null} */
      let index = null;
      try {
        index = await indexOf(api);
      } catch {
        // The list did not load: the id is opened as typed, and the server says whether it exists.
        msg.replaceChildren('The message list did not load, so the ID was not checked; opening it as typed.');
        openMessage(api, opts.host ?? null, id, opts.titleId);
        return;
      }
      if (index !== null && !index.has(id)) {
        if (index.has(`${id}.`)) {
          msg.replaceChildren('No message has that ID. Did you mean ', linkButton(`${id}.`, () => openMessage(api, opts.host ?? null, `${id}.`, opts.titleId), 'link mono'), ' with its trailing dot?');
        } else msg.replaceChildren('No message with this ID in the archive.');
        return;
      }
      msg.replaceChildren();
      openMessage(api, opts.host ?? null, id, opts.titleId);
    },
  }, input, el('button', { type: 'submit', class: 'btn' }, 'Open'));
  return el('div', null, form, msg);
}

// ---- The viewer ----

/** @type {WeakMap<Element, object>} */
const renders = new WeakMap();

/** @param {string} label @param {Kid[]} kids */
const metaLine = (label, ...kids) => el('p', null, el('b', null, `${label}: `), kids);

/**
 * The message viewer for opts.id, rendered into host: the id as the title, copy buttons and the git
 * show command; the quote line when opened from a quote and "Counted here as" when opened from an
 * action; mailbox, folder, date, role and processes from the index; the flag note; the raw text as
 * the file holds it (headers and body, CRLF and quoted-printable residue kept) in one <pre>, the quote
 * span marked at its stored offsets; the other copies of a duplicate; "Load all" for a long message;
 * a lookup form. Resolves once the text is on the page (or the reason it is not).
 * @param {Element} host @param {ViewerApi} api @param {ViewOptions} opts
 * @returns {Promise<void>}
 */
export async function messageView(host, api, opts) {
  const id = opts.id;
  const token = {};
  renders.set(host, token);
  const live = () => renders.get(host) === token;
  const titleId = opts.titleId ?? 'drawer-title';
  const cmd = `git show HEAD:"${id}"`;
  const cmdPre = el('pre', { class: 'cmd' }, cmd);
  const status = el('p', { class: 'note', 'aria-live': 'polite' }, 'Reading the message…');
  const lookup = () => [el('p', { class: 'label' }, 'Look up another message'), lookupForm(api, { host, titleId })];
  host.replaceChildren(
    el('p', { class: 'layer-kicker' }, 'Message'),
    el('h2', { class: 'layer-title mono', id: titleId }, id),
    el('div', { class: 'msg-actions' }, copyButton(id, 'Copy message ID'), copyButton(cmd, 'Copy the git show command', cmdPre)),
    cmdPre,
    status,
  );

  let indexFailed = false;
  const index = await indexOf(api).catch(() => {
    indexFailed = true;
    return null;
  });
  if (!live()) return;
  const row = index?.get(id) ?? null;
  if (index !== null && row === null) {
    status.replaceChildren('No message with this ID in the archive.');
    add(host, lookup());
    return;
  }
  /** @type {MessageText} */
  let msg;
  try {
    msg = await api.fetchMessage(id);
  } catch (err) {
    if (!live()) return;
    const reason = err instanceof Error ? err.message : String(err);
    const offline = err instanceof TypeError ? ' The dashboard server may have stopped: start it again with node obs.mjs serve.' : '';
    status.replaceChildren(`The message could not be read (${reason}).${offline}`);
    add(host, lookup());
    return;
  }
  if (!live()) return;
  const text = msg.text;

  const meta = el('div', { class: 'msg-meta' });
  if (indexFailed) meta.append(el('p', { class: 'note' }, 'The message list did not load, so its mailbox, date and processes are not shown here. The text below is read from the archive.'));
  const q = opts.quote ?? null;
  const split = q === null ? null : splitForMark(text, q.start, q.end);
  const marked = q !== null && split !== null && split.mark === q.raw_text ? split : null;
  if (q !== null) {
    if (marked !== null) {
      meta.append(metaLine('Quote', `${q.match === 'exact' ? 'exact match' : 'repaired match (equal once spacing and line breaks are set aside)'}, characters ${grouped(q.start + 1)} to ${grouped(q.end)} of the file${SEGMENT_WORDS[q.segment ?? ''] ?? ''}`));
    } else {
      meta.append(metaLine('Quote', 'its stored place does not match this text, so nothing is marked'));
    }
  }
  if (opts.action) {
    const words = ACTION_WORDS[opts.action] ?? opts.action;
    const minutes = api.rates?.minutes[opts.action];
    const pct = api.rates?.automatable_pct[opts.action];
    const rate = typeof minutes === 'number' && typeof pct === 'number' ? ` (${plural(minutes, 'minute', 'minutes')}${opts.action === 'read' ? ' each' : ''}, ${pct}% automatable)` : '';
    const by = opts.action === 'read' ? '' : `, by ${opts.counted_in?.by ?? (row === null ? 'its sender' : personName(row.from_name, row.from))}`;
    const where = opts.counted_in?.process ? `, in ${opts.counted_in.process}` : '';
    meta.append(metaLine('Counted here as', `${words}${rate}${by}${where}.`));
  }
  if (row !== null) {
    meta.append(metaLine('Mailbox', `${api.mailboxOwner?.(row.mailbox) ?? row.mailbox} · ${row.folder}`));
    meta.append(metaLine('Date', row.date_status === 'usable' ? dateTimeText(row.date_utc) : 'no usable date'));
    meta.append(metaLine('From', personName(row.from_name, row.from)));
    if (row.role !== null) meta.append(metaLine('Read by the run as', ROLE_WORDS[row.role] ?? row.role));
    if (row.duplicate_of === null && !row.flags.includes('flagged')) {
      const names = row.processes.map((k) => api.processName?.(k) ?? k);
      meta.append(metaLine('Counted under', names.length === 0 ? 'no recurring process' : names.join('; ')));
    }
    if (index !== null) {
      const { original, copies } = otherCopies(index, row);
      if (row.duplicate_of !== null) {
        meta.append(metaLine('A copy of', linkButton(original, () => openMessage(api, host, original, titleId), 'link mono'), ', which is the one counted'));
      }
      if (copies.length > 0) {
        meta.append(metaLine('Also appears as', copies.flatMap((c, i) => [i > 0 ? ', ' : '', linkButton(c, () => openMessage(api, host, c, titleId), 'link mono')])));
      }
    }
  }

  const flagged = row !== null && row.flags.includes('flagged');
  const flagNote = flagged
    ? el('p', { class: 'note flag' }, 'Flagged: this message is addressed to an automated reviewer. It is excluded from every count and its instructions were not followed. The text below is shown as data.')
    : null;

  const cut = lazyCut(text, marked === null ? 0 : (q?.end ?? 0));
  const pre = el('pre', { class: 'raw' });
  /** @type {HTMLElement | null} */
  let markEl = null;
  if (marked !== null && q !== null) {
    markEl = el('mark', { class: 'quote-mark' }, marked.mark);
    add(pre, [text.slice(0, q.start), markEl, text.slice(q.end, cut)]);
  } else add(pre, [text.slice(0, cut)]);
  /** @type {HTMLElement | null} */
  let more = null;
  if (cut < text.length) {
    const shown = text.slice(0, cut).split('\n').length - 1;
    const all = text.split('\n').length;
    const button = el('button', { type: 'button', class: 'btn' }, 'Load all');
    more = el('p', { class: 'more' }, `Showing the first ${plural(shown, 'line', 'lines')} of ${grouped(all)}. `, button);
    const box = more;
    button.addEventListener('click', () => {
      add(pre, [text.slice(cut)]);
      box.remove();
    });
  }

  status.remove();
  add(host, [meta, flagNote, el('p', { class: 'label' }, 'The message as the file holds it'), pre, more, lookup()]);
  if (markEl !== null && markEl.isConnected && typeof markEl.scrollIntoView === 'function') markEl.scrollIntoView({ block: 'center' });
}

// ---- The drafted documents: an escaping Markdown renderer ----
// The grammar of src/report/markdown.ts renderMarkdownHtml, built as nodes: paragraphs, ## and ###
// headings (a # title is dropped; the layer carries it), - and 1. lists, "- [ ]" items as text,
// > blockquotes (an indented one inside the list item above it), fenced blocks as <pre> (a fence
// opens only at the very start of a line, so none opens in a list item or quoted mail), tables,
// inline code (a message id becomes a button that opens it), **bold** and [placeholders] marked as
// blanks. Markdown's escapes read as the characters they stand for: a backslash before an ASCII
// punctuation mark, and the five entities the escapers write. No HTML in the document becomes markup.

// A [placeholder]: square brackets around text with a letter in it, not a "[ ]" checkbox.
const BRACKETED = /\[[^[\]\n]*\]/g;
/** @param {string} s */
const isBlank = (s) => /[A-Za-z]/.test(s);
// Lines are read with [\s\S], never ".": a line may hold U+2028 or U+2029, which "." does not match.
const FENCE = /^(\x60{3,}|~{3,})([\s\S]*)$/;
// The fence a line opens a fenced block with, or null: only at the very start of a line (never in a
// list item or quoted mail), and not a backtick fence whose info text holds a backtick.
/** @param {string} line @returns {string | null} */
function fenceAt(line) {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const mark = m[1] ?? '';
  return mark[0] === '\x60' && (m[2] ?? '').includes('\x60') ? null : mark;
}
// Whether a line closes the block its mark opened: the same character, as many of it or more,
// indented by three spaces or fewer, nothing after it but blanks.
/** @param {string} line @param {string} mark */
function closesFence(line, mark) {
  const indent = /^ {0,3}/.exec(line)?.[0].length ?? 0;
  const t = line.slice(indent).replace(/[ \t]+$/, '');
  return t.length >= mark.length && [...t].every((c) => c === mark[0]);
}
const NUL = String.fromCharCode(0);
const ESCAPED = /\\([!-/:-@[-\x60{-~])/g;
const HELD = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');
/** @type {Record<string, string>} */
const ENTITY = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
/** Text with its held characters back and its entities read. @param {string} text @param {string[]} held */
const plainText = (text, held) => text.replace(HELD, (_m, i) => held[Number(i)] ?? '').replace(/&(?:lt|gt|amp|quot|#39);/g, (e) => ENTITY[e] ?? e);
/** A code span as written: a held character goes back with its backslash. @param {string} text @param {string[]} held */
const rawText = (text, held) => text.replace(HELD, (_m, i) => `\\${held[Number(i)] ?? ''}`);
const INLINE = /(\x60[^\x60]+\x60|\*\*[^*]+\*\*|\[[^[\]\n]*\])/g;

/** @param {string} v @param {MarkdownHooks} hooks */
function codeSpan(v, hooks) {
  const isId = hooks.ids ? hooks.ids.has(v) : typeof hooks.onMessageId === 'function' && v.startsWith('corpus/');
  if (!isId) return el('code', null, v);
  const open = hooks.onMessageId;
  if (typeof open !== 'function') return el('code', { class: 'msg' }, v);
  return el('button', {
    type: 'button',
    class: 'link mono msg',
    onclick: (/** @type {Event} */ ev) => {
      ev.stopPropagation();
      open(v);
    },
  }, v);
}

/** Inline text as nodes. @param {string} source @param {MarkdownHooks} hooks @returns {Kid[]} */
function inline(source, hooks) {
  /** @type {string[]} */
  const held = [];
  const text = source.replace(ESCAPED, (_m, c) => `${NUL}${held.push(c) - 1}${NUL}`);
  /** @type {Kid[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(plainText(text.slice(last, at), held));
    const t = m[0];
    if (t.startsWith('\x60')) out.push(codeSpan(rawText(t.slice(1, -1), held), hooks));
    else if (t.startsWith('**')) out.push(el('strong', null, plainText(t.slice(2, -2), held)));
    else {
      const shown = plainText(t, held);
      out.push(isBlank(t) ? el('mark', { class: 'blank' }, shown) : shown);
    }
    last = at + t.length;
  }
  if (last < text.length) out.push(plainText(text.slice(last), held));
  return out;
}

/** Pre-formatted text with its placeholders marked. @param {string} text @returns {Kid[]} */
function preText(text) {
  /** @type {Kid[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(BRACKETED)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(isBlank(m[0]) ? el('mark', { class: 'blank' }, m[0]) : m[0]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** @param {string} line */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Split on every "|" not written as "\|", by a scan (a lookbehind would not parse in older Safari).
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '|' && s[i - 1] !== '\\') {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}
/** @param {string} line */
const isDelimiter = (line) => /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/.test(line.trim());

/**
 * A drafted document as nodes to place in the page, in order. hooks.ids: the message ids a code
 * span may name (with onMessageId it becomes a button that opens the message); hooks.base: the
 * heading level a "##" becomes (3).
 * @param {string} md @param {MarkdownHooks} [hooks] @returns {Node[]}
 */
export function renderMarkdown(md, hooks = {}) {
  const base = hooks.base ?? 3;
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  /** @param {number} j */
  const at = (j) => lines[j] ?? '';
  /** @type {Node[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ tag: 'ul' | 'ol', items: HTMLElement[] } | null} */
  let list = null;
  /** @type {string[]} */
  let quote = [];
  const flushPara = () => {
    if (para.length > 0) out.push(el('p', null, inline(para.join(' '), hooks)));
    para = [];
  };
  const flushList = () => {
    if (list !== null) out.push(el(list.tag, null, list.items));
    list = null;
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      const bq = el('blockquote', null, quote.map((q, i) => [i > 0 ? el('br') : null, inline(q, hooks)]));
      const item = list !== null && list.items.length > 0 ? list.items[list.items.length - 1] : null;
      if (item) item.append(bq);
      else out.push(bq);
    }
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = at(i);
    const line = raw.replace(/\s+$/, '');
    const mark = fenceAt(raw);
    if (mark !== null) {
      flushAll();
      /** @type {string[]} */
      const body = [];
      for (i++; i < lines.length && !closesFence(at(i), mark); i++) body.push(at(i));
      out.push(el('pre', null, preText(body.join('\n'))));
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushQuote();
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+([\s\S]*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = (heading[1] ?? '').length;
      if (level === 1) continue;
      out.push(el(`h${Math.min(6, base + level - 2)}`, null, inline((heading[2] ?? '').replace(/[ \t]+#+$/, ''), hooks)));
      continue;
    }
    const bq = /^[ \t]*>[ \t]?([\s\S]*)$/.exec(line);
    if (bq !== null) {
      flushPara();
      // An indented quote belongs to the list item above it (the Evidence footer's quotes); one at
      // the margin closes the list.
      if (quote.length === 0 && !/^[ \t]/.test(raw)) flushList();
      quote.push(bq[1] ?? '');
      continue;
    }
    flushQuote();
    if (line.includes('|') && i + 1 < lines.length && isDelimiter(at(i + 1))) {
      flushAll();
      const head = cells(line);
      /** @type {string[][]} */
      const rows = [];
      for (i += 2; i < lines.length && at(i).includes('|') && at(i).trim() !== ''; i++) rows.push(cells(at(i)));
      i--;
      out.push(el('table', null,
        el('thead', null, el('tr', null, head.map((c) => el('th', { scope: 'col' }, inline(c, hooks))))),
        el('tbody', null, rows.map((r) => el('tr', null, r.map((c) => el('td', null, inline(c, hooks))))))));
      continue;
    }
    const bullet = /^[ \t]*[-*+][ \t]+([\s\S]*)$/.exec(line);
    const numbered = /^[ \t]*\d{1,3}[.)][ \t]+([\s\S]*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item !== null) {
      flushPara();
      const tag = bullet !== null ? 'ul' : 'ol';
      if (list === null || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(el('li', null, inline(item[1] ?? '', hooks)));
      continue;
    }
    const last = list === null ? undefined : list.items[list.items.length - 1];
    if (last !== undefined && /^[ \t]{2,}\S/.test(raw) && para.length === 0) {
      add(last, [' ', inline(line.trim(), hooks)]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out;
}
