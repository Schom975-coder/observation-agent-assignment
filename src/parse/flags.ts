// Content flags on a parsed message. The injection scanner looks only at what the text says to an
// automated reader (CLAUDE.md, ARCHITECTURE 6.3 rule T1): no ID, Message-ID or header shape is
// consulted, so a planted trap with an ordinary ID is caught the same way as the corpus one.
// A flag never drops a message; it marks it as data to be bannered and reported.

// Above this a body is too large to show whole in a batch file (ARCHITECTURE 6.10).
export const OVERSIZE_BODY_CHARS = 32_000;

// The marker reported when the scan itself fails. A body the scanner cannot read is treated as
// suspect rather than stopping the run or passing as clean.
export const UNSCANNABLE = 'unscannable';

// Named phrases, matched case-insensitively with any whitespace (line wraps included) between words.
// Bodies are written by whoever sent the email, so every pattern must stay linear on hostile text:
// only single characters or character classes repeat without a bound (a greedy run of one class
// needs no backtracking stack), and a repeated group has a small fixed bound. An unbounded group
// such as (?:\s*,)+ pushes stack per repeat and overflows on a few million commas.
export const INJECTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'processing_directive', pattern: /\bprocessing\s+directive\b/i },
  { name: 'reviewing_process_shall', pattern: /\breviewing\s+(?:process|system|agent|model)\s+(?:shall|must)\b/i },
  {
    // "automated review, indexing or summarization process": up to 12 more activity words, each
    // after up to 8 separators (comma, slash, or, and).
    name: 'automated_review_process',
    pattern:
      /\bautomated\s+(?:review(?:ing)?|index(?:ing)?|summari[sz](?:ation|ing))(?:(?:\s*(?:[,/]|\bor\b|\band\b)){1,8}\s*(?:review(?:ing)?|index(?:ing)?|summari[sz](?:ation|ing))){0,12}\s+(?:process|system|agent|reader|tool|pipeline)e?s?\b/i,
  },
  { name: 'ignore_previous_instructions', pattern: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior)\s+instructions?\b/i },
  {
    name: 'supersede_prior_instructions',
    pattern:
      /\bsupersed(?:e|es|ed|ing)\s+(?:any\s+|all\s+)?(?:prior|previous)\s+instructions?\b|\b(?:prior|previous)\s+instructions?\b[^.]{0,120}?\bsuperseded\b/i,
  },
  { name: 'shall_not_cite', pattern: /\b(?:shall|must)\s+not\s+cite\b/i },
  { name: 'system_prompt', pattern: /\bsystem\s+prompt\b/i },
  { name: 'language_model', pattern: /\blanguage\s+models?\b/i },
  {
    name: 'addressed_to_ai',
    pattern: /\b(?:AI|artificial\s+intelligence)\s+(?:assistants?|agents?|models?|reviewers?|readers?)\b|\bautomated\s+(?:readers?|reviewers?)\b/i,
  },
];

// Names of the patterns found in `text`, in pattern order. Quote prefixes (">", "> >", ">>") and
// quoted-printable soft line breaks are removed first, so a forwarded or re-wrapped copy is caught
// as well. Never throws: if stripping or any pattern fails (the regex engine runs out of stack on
// some crafted multi-megabyte text), the patterns that did run are kept and UNSCANNABLE is added.
export function injectionMarkers(text: string, patterns: typeof INJECTION_PATTERNS = INJECTION_PATTERNS): string[] {
  let failed = false;
  let plain = text;
  try {
    plain = text.replace(/=\r?\n/g, '').replace(/^[ \t]*>[ \t>]*/gm, '');
  } catch {
    failed = true;
  }
  const found: string[] = [];
  for (const p of patterns) {
    try {
      if (p.pattern.test(plain)) found.push(p.name);
    } catch {
      failed = true;
    }
  }
  return failed ? [...found, UNSCANNABLE] : found;
}
