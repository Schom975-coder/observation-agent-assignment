// A small DOM for the tests of dashboard/viewer.js and dashboard/app.js in Node (no jsdom, no
// dependency): elements, text nodes, attributes, classes, CSSOM style properties, listeners, a few
// selectors (tag, .class, #id and tag.class), and a serializer that escapes text and attributes the
// way src/report/text.ts escapeHtml does, so a rendering can be compared with the report's HTML.
// Hand the document to viewer.js with useDocument(new ShimDocument()).

const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML[c] as string);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

type Listener = (ev: ShimEvent) => unknown;

export class ShimEvent {
  type: string;
  defaultPrevented = false;
  propagationStopped = false;
  target: ShimElement | null = null;
  currentTarget: ShimElement | null = null;
  constructor(type: string) {
    this.type = type;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

export class ShimNode {
  childNodes: ShimNode[] = [];
  parentNode: ShimElement | null = null;
  ownerDocument: ShimDocument;
  constructor(doc: ShimDocument) {
    this.ownerDocument = doc;
  }
  get isConnected(): boolean {
    let n: ShimNode | null = this;
    while (n !== null) {
      if (n instanceof ShimElement && n.connected) return true;
      n = n.parentNode;
    }
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  remove(): void {
    const p = this.parentNode;
    if (p !== null) {
      p.childNodes = p.childNodes.filter((c) => c !== this);
      this.parentNode = null;
    }
  }
}

export class ShimText extends ShimNode {
  readonly nodeType = 3;
  data: string;
  constructor(doc: ShimDocument, data: string) {
    super(doc);
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

export class ShimElement extends ShimNode {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly localName: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  styles = new Map<string, string>();
  value = '';
  connected = false; // set on a host the test treats as on the page
  scrolledIntoView = 0;
  readonly style = {
    setProperty: (name: string, value: string): void => void this.styles.set(name, value),
    getPropertyValue: (name: string): string => this.styles.get(name) ?? '',
  };
  readonly classList = {
    add: (...names: string[]): void => this.setClasses([...this.classes(), ...names]),
    remove: (...names: string[]): void => this.setClasses(this.classes().filter((c) => !names.includes(c))),
    contains: (name: string): boolean => this.classes().includes(name),
  };
  constructor(doc: ShimDocument, tag: string) {
    super(doc);
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
  }
  private classes(): string[] {
    return (this.attributes.get('class') ?? '').split(/\s+/).filter((c) => c !== '');
  }
  private setClasses(list: string[]): void {
    this.attributes.set('class', [...new Set(list)].join(' '));
  }
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(v: string) {
    this.attributes.set('class', v);
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  override get textContent(): string {
    return super.textContent;
  }
  override set textContent(v: string) {
    this.replaceChildren(v);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  appendChild<T extends ShimNode>(n: T): T {
    n.remove();
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...nodes: Array<ShimNode | string>): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  replaceChildren(...nodes: Array<ShimNode | string>): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  scrollIntoView(): void {
    this.scrolledIntoView++;
  }
  focus(): void {}
  // Calls this element's listeners for `type` and returns what they returned (an async listener's
  // promise, so a test can await it).
  dispatch(type: string): { event: ShimEvent; results: unknown[] } {
    const event = new ShimEvent(type);
    event.target = this;
    event.currentTarget = this;
    const results = (this.listeners.get(type) ?? []).map((fn) => fn(event));
    return { event, results };
  }
  click(): unknown[] {
    return this.dispatch('click').results;
  }
  matches(selector: string): boolean {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(?:#([\w-]+))?$/i.exec(selector.trim());
    if (m === null) throw new Error(`shim: unsupported selector ${selector}`);
    const [, tag, cls, id] = m;
    if (tag && tag.toLowerCase() !== this.localName) return false;
    for (const c of (cls ?? '').split('.').filter((x) => x !== '')) if (!this.classList.contains(c)) return false;
    return id === undefined || this.id === id;
  }
  querySelectorAll(selector: string): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (n: ShimNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof ShimElement) {
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class ShimDocument {
  // A body to hang a page's shell on, and lookups through it (simple selectors only), so app.js can
  // render a view with this document as the global one.
  readonly body: ShimElement = new ShimElement(this, 'body');
  getElementById(id: string): ShimElement | null {
    return this.body.querySelector(`#${id}`);
  }
  querySelector(selector: string): ShimElement | null {
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector: string): ShimElement[] {
    return this.body.querySelectorAll(selector);
  }
  createElement(tag: string): ShimElement {
    return new ShimElement(this, tag);
  }
  createElementNS(_ns: string, tag: string): ShimElement {
    return new ShimElement(this, tag);
  }
  createTextNode(data: string): ShimText {
    return new ShimText(this, data);
  }
  createRange(): { selectNodeContents: (n: unknown) => void } {
    return { selectNodeContents: () => {} };
  }
}

// HTML for a node, text and attribute values escaped as escapeHtml does, void elements unclosed.
export function serialize(n: ShimNode): string {
  if (n instanceof ShimText) return escape(n.data);
  if (!(n instanceof ShimElement)) return n.childNodes.map(serialize).join('');
  const attrs = [...n.attributes].map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
  if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
  return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

// The first element under `root` whose tag matches and whose text is `text` (or contains it).
export function byText(root: ShimElement, selector: string, text: string | RegExp): ShimElement | undefined {
  return root.querySelectorAll(selector).find((e) => (typeof text === 'string' ? e.textContent === text : text.test(e.textContent)));
}
