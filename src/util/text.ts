// The one newline normalization: CRLF and a lone CR both become LF. The batch renderer shows
// bodies through it, and the quote validator must use this same function on both sides, so a
// quote copied from a batch file matches the raw message it came from (ARCHITECTURE.md 6.11).
export const normalizeNewlines = (s: string): string => s.replace(/\r\n?/g, '\n');
