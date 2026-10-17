// Content flags on a parsed message. The injection scanner looks only at what the text says to an
// automated reader (CLAUDE.md, ARCHITECTURE 6.3 rule T1): no ID, Message-ID or header shape is
// consulted, so a planted trap with an ordinary ID is caught the same way as the corpus one.
// A flag never drops a message; it marks it as data to be bannered and reported.

// Above this a body is too large to show whole in a batch file (ARCHITECTURE 6.10).
export const OVERSIZE_BODY_CHARS = 32_000;

// Named phrases, matched case-insensitively with any whitespace (line wraps included) between words.
export const INJECTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'processing_directive', pattern: /\bprocessing\s+directive\b/i },
  { name: 'reviewing_process_shall', pattern: /\breviewing\s+(?:process|system|agent|model)\s+(?:shall|must)\b/i },
  {
    name: 'automated_review_process',
    pattern:
      /\bautomated\s+(?:review(?:ing)?|index(?:ing)?|summari[sz](?:ation|ing))(?:(?:\s*(?:,|\/|\bor\b|\band\b))+\s*(?:review(?:ing)?|index(?:ing)?|summari[sz](?:ation|ing)))*\s+(?:process|system|agent|reader|tool|pipeline)e?s?\b/i,
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

// Names of the patterns found in `text`. Quote prefixes and quoted-printable soft line breaks
// are removed first, so a forwarded or re-wrapped copy is caught as well.
export function injectionMarkers(text: string): string[] {
  const plain = text.replace(/=\r?\n/g, '').replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  return INJECTION_PATTERNS.filter((p) => p.pattern.test(plain)).map((p) => p.name);
}
