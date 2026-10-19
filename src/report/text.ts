// The only escapers (ARCHITECTURE.md 5.10). Every string that came from a model or an email (process
// names, synthesis prose, quotes, subjects, display names, artifact bodies) is data: in report.html it
// passes through escapeHtml; in report.md a data string passes through escapeMdText (one line, inert
// anywhere) and a Markdown body (a drafted document) through inertMarkdown (its structure kept, its
// links, images, HTML and open fences made text). Nothing else turns data into markup.

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

// The container prefix of a Markdown line (blockquote markers and the indentation around them) and
// the rest.
const CONTAINER = /^((?:[ \t]*>)*[ \t]*)(.*)$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

// A Markdown body (a drafted document, an artifact's Evidence footer) made inert while its structure
// stays: headings, lists, emphasis, blockquotes, tables and [placeholders] read as before. What could
// act or escape becomes text: a link or an image ("](" and "!["), a reference definition ("[x]: ..."),
// raw HTML and angle-bracket autolinks ("<"), and a fence that never closes. A fenced block with its
// closing fence stays as it is (its content is shown as code, inert already); any fence line inside a
// blockquote (quoted mail) and any lone setext underline in one become text. Idempotent: a second
// pass changes nothing.
export function inertMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const [, prefix = '', rest = ''] = CONTAINER.exec(line) as RegExpExecArray;
    const quoted = prefix.includes('>');
    const fence = quoted ? FENCE_OPEN.exec(rest.replace(/^[ \t]*/, '')) : FENCE_OPEN.exec(line);
    if (fence !== null && !quoted) {
      const mark = fence[2] as string;
      const closer = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
      let end = -1;
      if (!(mark[0] === '`' && (fence[3] as string).includes('`'))) {
        for (let j = i + 1; j < lines.length; j++) {
          if (closer.test(lines[j] as string)) {
            end = j;
            break;
          }
        }
      }
      if (end !== -1) {
        // A closed fenced block: kept whole.
        for (let j = i; j <= end; j++) out.push(lines[j] as string);
        i = end;
        continue;
      }
      out.push(`${fence[1]}\\${(fence[2] as string)}${inertInline(fence[3] as string)}`);
      continue;
    }
    if (fence !== null && quoted) {
      // A fence line in quoted mail: text.
      const lead = /^[ \t]*/.exec(rest)?.[0] ?? '';
      out.push(`${prefix}${lead}\\${inertInline(rest.slice(lead.length))}`);
      continue;
    }
    // A reference definition, at the margin or in a quote: its bracket escaped.
    const def = /^( {0,3})\[([^\]]*)\]:/.exec(rest);
    if (def !== null) {
      out.push(`${prefix}${def[1]}\\${inertInline(rest.slice((def[1] as string).length))}`);
      continue;
    }
    // A run of = or - alone under a line of text would underline it as a heading (in quoted mail,
    // always): text. After a blank line a run of - stays the rule it is.
    const previous = (out.at(-1) ?? '').replace(/^(?:[ \t]*>)*[ \t]*/, '');
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(rest) && (quoted || previous.trim() !== '')) {
      const lead = /^ */.exec(rest)?.[0] ?? '';
      out.push(`${prefix}${lead}\\${rest.slice(lead.length)}`);
      continue;
    }
    out.push(`${prefix}${inertInline(rest)}`);
  }
  return out.join('\n');
}

// Within a line: "<" as an entity, the "(" of "](" and the "[" of "![" escaped.
function inertInline(s: string): string {
  return s
    .replace(/</g, '&lt;')
    .replace(/!\[/g, '!\\[')
    .replace(/\]\(/g, ']\\(');
}
