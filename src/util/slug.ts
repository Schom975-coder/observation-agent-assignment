// The one slug function (CLAUDE.md, "Same output on every OS"): every file or folder name built from
// model output goes through it, so a name is valid and means the same thing on Windows, macOS and
// Linux. The result is lowercase ASCII letters, digits and single hyphens, none leading or trailing,
// at most SLUG_MAX_CHARS characters: nothing Windows forbids in a name (\ / : * ? " < > |), no
// trailing dot or space, and never a Windows reserved device name (CON, PRN, AUX, NUL, COM1-COM9,
// LPT1-LPT9), which gets the SLUG_PREFIX. A process key already satisfies all of it, so it comes back
// unchanged unless it is a reserved name. Same input, same slug; a slug slugified again is itself.

export const SLUG_MAX_CHARS = 48;
// Put in front of a reserved name, and the whole slug of a text with no letter or digit in it.
export const SLUG_PREFIX = 'p-';
export const EMPTY_SLUG = `${SLUG_PREFIX}empty`;

const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

export const isReservedName = (name: string): boolean => RESERVED.has(name.toLowerCase());

export function slugify(text: string): string {
  // Lowercase, accents folded (é -> e), then every run of anything else is one hyphen.
  let s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX_CHARS) {
    // Cut at the last hyphen that keeps it within the limit, so a word is not split; a single
    // long word is cut where the limit falls.
    const cut = s.slice(0, SLUG_MAX_CHARS + 1);
    const hyphen = cut.lastIndexOf('-');
    s = (hyphen > 0 ? cut.slice(0, hyphen) : s.slice(0, SLUG_MAX_CHARS)).replace(/-+$/g, '');
  }
  if (s === '') return EMPTY_SLUG;
  return RESERVED.has(s) ? `${SLUG_PREFIX}${s}` : s;
}
