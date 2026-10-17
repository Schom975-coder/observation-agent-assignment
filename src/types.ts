// Shared records passed between stages. Change only with every consumer in view:
// parse writes ParsedMessage, normalize and actions read it, later stages build on both.

export type DateStatus = 'usable' | 'missing' | 'unparseable' | 'out_of_range';

export type ParsedDate = {
  // "YYYY-MM-DDTHH:MM:SSZ" when status is 'usable', otherwise null.
  utc: string | null;
  status: DateStatus;
};

export type Address = {
  // Lowercased, trimmed; the identity of a person everywhere downstream.
  email: string;
  // Display name if the header carried one, e.g. "Cernosek, Clem"; otherwise null.
  name: string | null;
};

// own = text the sender wrote in this message; quoted = an earlier message included in a reply;
// forwarded = an earlier message passed on. Offsets index into `bytes.toString('utf8')` of the
// whole raw message (headers included), end exclusive, original line endings kept.
export type SegmentKind = 'own' | 'quoted' | 'forwarded';
export type Segment = { kind: SegmentKind; start: number; end: number };

export type ParsedMessage = {
  id: string; // exact Git path, e.g. "corpus/farmer-d/logistics/1."
  blob_sha: string;
  mailbox: string; // "farmer-d"
  folder: string; // "logistics", "inbox", "sent_items"
  message_id: string | null; // Message-ID header value, unparsed
  date_raw: string | null; // Date header as written
  date_utc: string | null;
  date_status: DateStatus;
  from: Address | null;
  to: Address[];
  cc: Address[]; // Bcc is ignored: in this export it mirrors Cc
  subject: string; // unfolded, trimmed, as written
  subject_norm: string; // lowercase, leading re:/fw:/fwd: stripped, whitespace collapsed, trailing punctuation stripped
  reply_or_forward_subject: boolean; // subject starts with re:/fw:/fwd: (any case)
  body_start: number; // offset of the first body character (after the blank line ending the headers)
  body_chars: number;
  segments: Segment[]; // cover the body in order, no gaps or overlaps
  own_chars: number; // own-segment text, whitespace-collapsed, length
  // No re:/fw:/fwd: subject prefix and no quoted or forwarded segment: starts a new occurrence.
  fresh_send: boolean;
  flags: {
    oversize: boolean; // body too large to show whole in a batch file
    suspected_injection: boolean; // content addresses an automated reader with instructions
    injection_markers: string[]; // which phrases matched, for the Methodology page
  };
};

// The same email stored more than once (exported twice, or copied into several mailboxes).
// Only the canonical (lowest dated ID, else lowest ID) goes on to threads, batches and counting.
export type DuplicateGroup = {
  canonical: string;
  duplicates: Array<{
    id: string;
    // content: in the canonical's own content cluster (same sender, subject and body, under 24 h
    // after the cluster's first copy), even if a Message-ID matches too; message_id: reached
    // through a shared Message-ID header, directly or via one of that copy's content copies.
    rule: 'content' | 'message_id';
    recipients_differ: boolean; // To+Cc address set differs from the canonical's
  }>;
};

// One round of a recurring piece of work: a fresh send and the replies and forwards after it.
export type Occurrence = { occurrence_id: string; message_ids: string[] };

export type Thread = {
  thread_id: string; // "t-" + 12 hex of the first message's ID hash: stable when other threads change
  subject_norm: string;
  message_ids: string[]; // unique messages only; dated in time order, then undated by ID
  first_utc: string | null;
  last_utc: string | null;
  participants: string[]; // sender and To/Cc addresses, sorted
  occurrences: Occurrence[];
};

export type Person = {
  email: string;
  name: string | null; // most frequent display name seen for this address
  sent: number; // unique messages sent
  received: number; // unique messages received (To/Cc)
  priced: boolean; // company staff, per config priced_domains
};

export type BatchEntry = {
  batch_id: string; // "batch-000"
  file: string; // "out/batches/batch-000.md"
  message_ids: string[];
  thread_ids: string[];
  bytes: number;
  lines: number; // as the Read tool numbers them
  // (bytes + 8 per line for Read's line-number prefix) / 3, rounded up: deliberately pessimistic
  // for number-heavy text
  est_tokens: number;
  content_sha: string;
};

// What one message counts as in the email-trail model (see ARCHITECTURE.md 4.1).
export type AuthoredAction = 'chaser' | 'forward' | 'authored_short' | 'authored_medium' | 'authored_long';

export type MessageActions = {
  id: string;
  authored: AuthoredAction;
  sender_priced: boolean; // sender's domain is a priced (company) domain
  reads: Array<{ email: string; priced: boolean }>; // distinct recipients, sender excluded, capped
};

// ---- Model stages (M3 on). What extractor subagents write, and what validation makes of it. ----
// No model-facing type has a field for hours, minutes, dollars, counts or rank: the headline
// numbers come only from counted actions (CLAUDE.md "Hours and dollars").

export const MESSAGE_ROLES = [
  'request',
  'response',
  'forward',
  'fyi',
  'automated',
  'personal',
  'noise',
  'injection_attempt',
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const STALL_KINDS = [
  'waiting_on_reply',
  'rework',
  'handoff_confusion',
  'ownership_conflict',
  'avoidance',
  'system_failure',
  'other',
] as const;
export type StallKind = (typeof STALL_KINDS)[number];

// out/extract/<batch_id>.json, written by an extractor subagent. Strict: unknown keys are errors.
export type Extraction = {
  batch_id: string;
  messages: Array<{
    id: string; // exactly the batch's message IDs, each once
    processes: string[]; // taxonomy keys or "new:<slug>"; [] only for personal, noise, automated, injection_attempt
    role: MessageRole;
    stall: null | { kind: StallKind; quote: string };
    ownership_claim: null | { person: string; quote: string };
  }>;
  evidence: Array<{
    process: string; // one of that message's processes
    message_id: string;
    field: 'body' | 'subject';
    quote: string; // verbatim, 20-400 characters (a whole subject may be shorter)
    note: string; // <= 200 characters: why this quote is evidence
  }>;
  new_processes: Array<{ key: string; name: string; definition: string; example_ids: string[] }>; // key "new:<slug>"
  batch_notes: string; // <= 100 words
};

export type QuoteMatch = 'exact' | 'repaired' | 'rejected';

// Where a quote sits in the raw message. Offsets index into bytes.toString('utf8') of the whole raw
// message (the Segment convention), so the dashboard can highlight the raw text itself.
export type QuoteCheck = {
  match: QuoteMatch;
  start: number | null;
  end: number | null;
  segment: SegmentKind | 'subject' | null; // where the quote starts
  raw_text: string | null; // the raw span the quote resolved to: what the dashboard shows
  reason: string | null; // for rejected: not_found | too_short | too_long | empty | wrong_message
};

export type ValidatedEvidence = Extraction['evidence'][number] & QuoteCheck & { evidence_id: string };

// out/validated/<batch_id>.json: the extraction with every quote checked and located.
export type ValidatedExtraction = {
  batch_id: string;
  content_sha: string; // of the batch file the extraction was made from
  messages: Extraction['messages'];
  evidence: ValidatedEvidence[]; // rejected ones kept with match "rejected"; they never ship
  stall_checks: Array<{ message_id: string } & QuoteCheck>;
  ownership_checks: Array<{ message_id: string; person: string } & QuoteCheck>;
  new_processes: Extraction['new_processes'];
  batch_notes: string;
  quote_stats: { exact: number; repaired: number; rejected: number };
};

// Result of checking one extraction file. `problems` are what a fix-round prompt hands back to the
// extractor; `setup` is a failure no model can fix, which is never recorded against the batch.
export type ExtractionCheck = {
  ok: boolean; // no setup failure and no problems
  setup: string | null; // unreadable out/, changed corpus bytes and the like; `problems` is then empty
  problems: string[]; // model-fixable only, most important first, each naming the message ID or quote involved
  validated: ValidatedExtraction | null; // null when the file can't be read, fails the schema, or on a setup failure
};
