// The only escapers (ARCHITECTURE.md 5.10). Every string that came from a model or an email (process
// names, synthesis prose, quotes, subjects, display names, artifact bodies) is data: in report.html it
// passes through escapeHtml; in report.md a data string passes through escapeMdText (one line, inert
// anywhere) and a Markdown body (a drafted document) through inertMarkdown (its structure kept, its
// links, reference definitions, images, HTML and stray fences made text). Nothing else turns data
// into markup.

const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text for HTML element content or a quoted attribute value.
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML[c] as string);

// One line of text for Markdown, inert at any position in a line: a backslash before \ ` * _ [ ] # >
// | ~ (emphasis, links, headings, quotes, tables, strikethrough, fences); before the marker of a
// leading list item ("12." "1)" "-" "+") and a leading "=" (a setext underline); "&" written as
// "&amp;" where it would start an entity; "<" as "&lt;" (no HTML tag or autolink can open, and a
// raw-text check sees none). Line breaks are kept; escapeMdText makes one line first.
export function escapeMd(s: string): string {
  return s
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/[\\`*_[\]#>|~]/g, (c) => `\\${c}`)
    .replace(/</g, '&lt;')
    .replace(/^(\s*\d+)([.)])/gm, '$1\\$2')
    .replace(/^(\s*)([-+=])/gm, '$1\\$2');
}

// A data string on one line: its line breaks as spaces, then escaped.
export const escapeMdText = (s: string): string => escapeMd(s.replace(/\r\n?|\n/g, ' '));

// One table cell: the same.
export const escapeMdCell = escapeMdText;

// Every pattern below reads a line with [\s\S], never ".": a line may hold U+2028 or U+2029, which
// Markdown treats as ordinary characters and "." does not match.

// A fence: three or more backticks or tildes, and the info text after it.
const FENCE = /^(`{3,}|~{3,})([\s\S]*)$/;
// What can stand in front of a line's text: blanks, blockquote markers and list markers ("-", "+",
// "*", "12.", "3)").
const LEAD = /^(?:[ \t]|>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))*/;
// The container prefix of a line (blockquote markers and the blanks around them) and the rest.
const CONTAINER = /^((?:[ \t]*>)*[ \t]*)([\s\S]*)$/;

// The fence a line opens a fenced block with, or null. Here a fenced block opens only at the very
// start of a line, never after blanks, a list marker or a quote marker, so no block ever opens
// inside a list item or quoted mail; a backtick fence whose info text holds a backtick opens none
// (as in CommonMark). The draft gate, the report's renderer and inertMarkdown share this rule.
export function fenceAt(line: string): string | null {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const mark = m[1] as string;
  return mark[0] === '`' && (m[2] as string).includes('`') ? null : mark;
}

// Whether a line closes the block `mark` opened: the same character, at least as many of it,
// indented at most three spaces, and nothing after it but blanks.
export function closesFence(line: string, mark: string): boolean {
  const indent = /^ {0,3}/.exec(line)?.[0].length ?? 0;
  const t = line.slice(indent).replace(/[ \t]+$/, '');
  return t.length >= mark.length && [...t].every((c) => c === mark[0]);
}

// The index of the line closing the block that line `i` opens with `mark`, or -1 when none does.
function closingLine(lines: readonly string[], i: number, mark: string): number {
  for (let j = i + 1; j < lines.length; j++) if (closesFence(lines[j] as string, mark)) return j;
  return -1;
}

// A Markdown body (a drafted document, an artifact's Evidence footer) made inert while its structure
// stays: headings, lists, emphasis, blockquotes, tables and [placeholders] read as before. What could
// act or escape becomes text, wherever it stands (at the margin, in a list item, in quoted mail): a
// link or an image ("](" and "!["), a reference definition ("]:", so no label of any shape can
// define one), raw HTML and angle-bracket autolinks ("<"), a fence that never closes, a fence after
// blanks, a list marker or a quote marker, and a lone setext underline under text (in quoted mail,
// any). A fenced block opened at the margin with its closing fence stays as it is: its content is
// shown as code, inert already. Idempotent: a second pass changes nothing.
export function inertMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const mark = fenceAt(line);
    if (mark !== null) {
      const end = closingLine(lines, i, mark);
      if (end !== -1) {
        // A closed fenced block: kept whole.
        out.push(...lines.slice(i, end + 1));
        i = end;
        continue;
      }
      out.push(`\\${inertInline(line)}`);
      continue;
    }
    const lead = (LEAD.exec(line) as RegExpExecArray)[0];
    if (lead !== '' && FENCE.test(line.slice(lead.length))) {
      // A fence in a list item, in quoted mail or after blanks: text.
      out.push(`${lead}\\${inertInline(line.slice(lead.length))}`);
      continue;
    }
    // A run of = or - alone under a line of text would underline it as a heading (in quoted mail,
    // always): text. After a blank line a run of - stays the rule it is.
    const [, prefix = '', rest = ''] = CONTAINER.exec(line) as RegExpExecArray;
    const previous = (out.at(-1) ?? '').replace(/^(?:[ \t]*>)*[ \t]*/, '');
    if (/^(?:=+|-+)[ \t]*$/.test(rest) && (prefix.includes('>') || previous.trim() !== '')) {
      out.push(`${prefix}\\${rest}`);
      continue;
    }
    out.push(inertInline(line));
  }
  return out.join('\n');
}

// Within a line: "<" as an entity, the "(" of "](", the ":" of "]:" and the "[" of "![" escaped.
function inertInline(s: string): string {
  return s
    .replace(/</g, '&lt;')
    .replace(/!\[/g, '!\\[')
    .replace(/\]\(/g, ']\\(')
    .replace(/\]:/g, ']\\:');
}
