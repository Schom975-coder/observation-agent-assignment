// Shared records passed between stages. Change only with every consumer in view:
// parse writes ParsedMessage, normalize and actions read it, later stages build on both.
import type { ActionType } from './config.ts';

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

// What an address is (src/normalize/identity.ts): a person, a distribution list (its readers are
// staff, the list itself is not), or a system sender named in config/effort-rates.json
// system_senders (unpriced).
export type PersonKind = 'person' | 'list' | 'system';
// The rule that folded an address into another (ARCHITECTURE.md 4.1, "Participant identity").
export type FoldRule = 'display_name' | 'middle_initial' | 'last_name' | 'first_last' | 'initial_last';

// One address as buildPeople counts it, before the identity fields are added.
export type PersonCounts = {
  email: string;
  name: string | null; // most frequent display name seen for this address (the taxonomy digest reads it)
  sent: number; // unique messages sent
  received: number; // unique messages received (To/Cc)
  priced: boolean; // domain in config priced_domains
};

// One record of out/people.json: the counts, and who the address is.
export type Person = PersonCounts & {
  kind: PersonKind;
  canonical: string; // the address this one folds into, chains followed; itself when none
  fold: FoldRule | null; // the rule of this address's own fold (its first link); null when none
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
  sender_priced: boolean; // the sender is a priced party: a priced domain and not a system sender
  reads: Array<{ email: string; priced: boolean }>; // distinct recipients, sender excluded, capped
};

// ---- Model stages (M3 on). What extractor subagents write, and what validation makes of it. ----
// No model-facing type has a field for hours, minutes, dollars, counts or rank, with one exception:
// the synthesizer's WorkEstimate (minutes per occurrence and an automatable share, M5), which code
// bounds, checks for citations and lets a file override. Counts, windows, tiers and ranks are code's.

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

// ---- Jobs (M5): extraction batches and synthesis groups go through one ledger ----

// A job's kind is its ID prefix: "batch-NNN", "synth-NNN" or "draft-NNN" (ARCHITECTURE.md 6.21).
export type JobKind = 'batch' | 'synth' | 'draft';
// What the ledger needs of any index entry: the job's ID, its input file and that file's hash.
export type JobEntry = { id: string; file: string; content_sha: string };

// Result of checking one model output file. `problems` are what a fix-round prompt hands back to
// the agent; `setup` is a failure no model can fix, which is never recorded against the job.
export type JobCheck<T> = {
  ok: boolean; // no setup failure and no problems
  setup: string | null; // unreadable out/, changed corpus bytes and the like; `problems` is then empty
  problems: string[]; // model-fixable only, most important first, each naming the entry involved
  validated: T | null; // null when the file can't be read, fails the schema, or on a setup failure
};
export type ExtractionCheck = JobCheck<ValidatedExtraction>;

// Counts per action type, every type present (src/metrics/actions.ts builds them).
export type ActionCounts = Record<ActionType, number>;

// ---- Merge (M5, ARCHITECTURE.md 5.6) ----

// out/merge-proposed.json, written by the merger subagent. Strict: unknown keys rejected, no
// numeric field anywhere. Every "new:" key of the input appears exactly once across the lists in
// `mapped`, `unassigned` and the promoted aliases.
export type MergeProposal = {
  mapped: Record<string, string[]>; // taxonomy key -> the "new:" keys whose messages count under it
  unassigned: string[]; // the "new:" keys counted under no process
  promoted: Array<{ key: string; name: string; definition: string; aliases: string[] }>;
};

// What became of one proposed key. mapped: counted under the taxonomy key `to`; promoted: it names
// a promoted process (`to`, the slug "new:<to>"); alias: folded into the promoted process `to`
// under another name; unassigned: the merger left it out; demoted: promoted, but too small when
// counted (the reason says by how much). Unassigned and demoted keys are counted nowhere.
export type MergeSlugStatus = 'mapped' | 'promoted' | 'alias' | 'unassigned' | 'demoted';

// out/merge.json, written by code from an accepted proposal.
export type MergeTable = {
  version: 1;
  extractions_sha: string;
  taxonomy_sha: string;
  agent_sha: string;
  // config/scoring.json merge.promote_min as the promotions were sized: a change makes the table stale
  promote_min: { messages: number; occurrences: number; threads: number; active_months: number };
  slugs: Array<{ slug: string; messages: number; batches: number; status: MergeSlugStatus; to: string | null; reason: string | null }>; // sorted by slug
  promoted: Array<{
    key: string;
    name: string;
    definition: string;
    include: string[]; // always [] since the proposal stopped carrying notes; kept so the shape is unchanged
    exclude: string[]; // likewise
    aliases: string[];
    messages: number;
    occurrences: number;
    threads: number;
    active_months: number;
  }>; // sorted by key; only the promotions that passed the size check
  counts: {
    slugs: number;
    mapped: number;
    promoted: number; // promoted processes kept
    aliases: number; // slugs folded into a kept promotion (status promoted or alias)
    unassigned: number;
    demoted: number;
    messages_mapped: number; // distinct messages with at least one mapped slug
    messages_promoted: number; // distinct messages with at least one slug in a kept promotion
    messages_unassigned: number; // distinct messages whose every slug is unassigned or demoted
  };
};

// ---- Rollup (M5, ARCHITECTURE.md 4.1, 5.7) ----

export type ActionSource = {
  message_id: string;
  type: AuthoredAction | 'read';
  person: string; // the canonical address of the sender (authored) or the recipient (read)
  address: string; // the address as the message has it
  priced: boolean; // a priced party: a priced domain (priced_domains) and not a system sender
  share_x100: number; // the message's share for this process: 100 unless it carries several merged keys
};

// One identity on a process's trail. `email` is the canonical address; `addresses` the addresses of
// this identity seen in this process, sorted; `name` the identity's display name; `staff` true for a
// person at a priced domain (a list or a system sender never is).
export type Participant = {
  email: string;
  name: string | null;
  kind: PersonKind;
  addresses: string[];
  staff: boolean;
  authored: number;
  forwards: number;
  chasers: number;
  reads: number;
};

export type ProcessWindow = {
  first_utc: string | null; // earliest usable-date tagged message
  last_utc: string | null;
  span_days: number;
  months_x100: number; // max(100, roundHalfUp(span_days * 1600 / 487))
  active_months: number;
  undated_occurrences: number; // occurrences with no usable-date tagged message
};

// Whom an ownership claim names, resolved against the process's participants only (src/metrics/rollup.ts
// matchClaim): one participant, several, none, or a group or role rather than one person.
export type ClaimStatus = 'matched' | 'several' | 'unmatched' | 'group';
export type ClaimMatch = { status: ClaimStatus; people: string[]; name: string | null }; // people: canonical addresses, sorted; name: the display name when matched
export type OwnershipClaim = { message_id: string; person: string; date_utc: string | null; quote: string; match: ClaimMatch };
// Two claims naming different people at most OWNERSHIP_CONFLICT_DAYS apart: their message IDs, `a`
// the earlier claim (by date, then ID), and the whole days between them.
export type ConflictPair = { a: string; b: string; days_apart: number };
// From a tagged message to the next message in its thread by another identity, in tenths of an hour.
export type ReplyGap = { from: string; to: string; hours_x10: number };

export type ProcessRollup = {
  key: string;
  name: string;
  origin: 'taxonomy' | 'promoted';
  definition: string;
  message_ids: string[]; // ID order
  thread_ids: string[];
  occurrence_ids: string[];
  occurrences: number;
  occurrence_share_x100: number;
  shared_occurrences: number; // occurrences counted at less than a whole round
  window: ProcessWindow;
  monthly: Array<{ month: string; occurrences: number; messages: number }>;
  actions: { priced: ActionCounts; unpriced: ActionCounts };
  action_sources: ActionSource[];
  email_x100: { today: number; automatable: number }; // whole window, the rollup's rates
  participants: Participant[]; // by actions desc, then email
  staff_participants: number; // participants with staff: true
  reply_gaps: ReplyGap[]; // sorted by from, then to
  reply_gap_n: number; // reply_gaps.length
  median_reply_gap_h: number | null; // over reply_gaps
  chasers: number;
  stalls: Array<{ message_id: string; kind: StallKind; quote: string; start: number; end: number }>; // validated stall quotes only
  ownership_claims: OwnershipClaim[];
  ownership_conflicts: ConflictPair[]; // sorted by a, then b
  evidence_ids: string[]; // accepted evidence under this merged key
  flags: string[];
};

export type Coverage = {
  files: number; // every file in the corpus, duplicates included
  unique: number;
  classified: number; // in a done batch's validated extraction
  tagged: number; // at least one process tag as extracted
  counted: number; // at least one merged key
  unassigned: number; // tagged, but every tag ended unassigned
  role_only: Record<string, number>; // no process tag, by role
};

// out/rollup.json
export type Rollup = {
  version: 1;
  inputs: { extractions_sha: string; merge_sha: string; corpus_hash: string; rates_sha: string };
  processes: ProcessRollup[]; // sorted by key
  unassigned: {
    messages: number;
    message_ids: string[];
    slugs: Array<{ slug: string; messages: number; status: 'unassigned' | 'demoted'; reason: string | null }>;
  };
  coverage: Coverage;
};

// ---- Synthesis (M5, ARCHITECTURE.md 5.3, 5.8) ----

// One line of out/synthesis/index.json.
export type SynthEntry = { group_id: string; file: string; process_keys: string[]; bytes: number; lines: number; est_tokens: number; content_sha: string };

export const ARTIFACT_TYPES = ['sop', 'checklist', 'email_template', 'template', 'none'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const ESTIMATE_BASES = ['observed', 'inferred', 'self_reported'] as const;
export type EstimateBasis = (typeof ESTIMATE_BASES)[number];

// The one numeric record a model writes (ARCHITECTURE.md 6.20), bounded and checked by code.
export type WorkEstimate = {
  minutes_per_occurrence: { low: number; mid: number; high: number };
  automatable_pct: number;
  basis: EstimateBasis;
  rationale: string;
  evidence_ids: string[];
};

export type SynthesisProcess = {
  key: string;
  description: string;
  steps: string[];
  stalls: Array<{ summary: string; evidence_ids: string[] }>;
  contradictions: Array<{ summary: string; evidence_ids: string[] }>;
  automation: { approach: string; artifact_type: ArtifactType; rationale: string };
  work_estimate: WorkEstimate | null;
};

// out/synthesis/raw/<group_id>.json, written by a synthesizer subagent. Strict schema.
export type SynthesisGroup = { group_id: string; processes: SynthesisProcess[] };

// out/synthesis/validated/<group_id>.json: the raw record checked, with the group input's hash
// and, per estimate, the occurrences and senders its cited ids come from, as counted.
export type ValidatedSynthesis = {
  group_id: string;
  content_sha: string;
  processes: Array<SynthesisProcess & { estimate_check: null | { occurrences_cited: number; senders_cited: number } }>;
};

// out/synthesis/input/<group_id>.json: every id the group input shows, per process, with what the
// validator needs to count occurrences and senders behind an estimate. Ids and addresses, no quotes.
export type SynthCited = {
  id: string; // "batch-021:e4" (evidence), "batch-021:s2" (stall), "batch-021:o0" (ownership claim)
  kind: 'evidence' | 'stall' | 'ownership';
  message_id: string;
  occurrence_id: string;
  sender: string; // the sender's canonical address: one person under several addresses is one sender
  date_utc: string | null;
};
export type SynthSidecar = { group_id: string; processes: Array<{ key: string; occurrences: number; cited: SynthCited[] }> };

// config/estimates.json (optional): human estimates that replace the model's for the keys named.
export type EstimatesOverride = {
  version: 1;
  estimates: Record<string, { minutes_per_occurrence: WorkEstimate['minutes_per_occurrence']; automatable_pct: number; rationale: string }>;
};

// ---- Score (M5, ARCHITECTURE.md 5.4) ----

export type Tier = 'A' | 'B' | 'C';
export type MinutesPair = { today: number; automatable: number };

export type Opportunity = {
  rank: number;
  key: string;
  name: string;
  origin: 'taxonomy' | 'promoted';
  tier: Tier;
  counted: {
    occurrences: number;
    occurrence_share_x100: number;
    shared_occurrences: number;
    window: ProcessWindow;
    staff_participants: number;
    participants: Participant[];
    actions: { priced: ActionCounts; unpriced: ActionCounts };
    email_x100: MinutesPair; // whole window, at the rates scored with
    email_per_month_x100: MinutesPair;
    reply_gap: { n: number; median_h: number | null }; // the median is shown only with n >= 5 (a build rule)
  };
  estimated: null | {
    source: 'model' | 'override';
    minutes_per_occurrence: { low: number; mid: number; high: number };
    automatable_pct: number;
    basis: string;
    rationale: string;
    evidence_ids: string[];
    occurrences_cited: number;
    senders_cited: number;
    work_per_month_x100: MinutesPair;
  };
  per_month_x100: MinutesPair; // email + work
  hours_per_month_x100: MinutesPair;
  dollars_per_month_cents: MinutesPair; // cents of the email part + cents of the work part
  // Automatable minutes per month and cents with the estimate at its low and at its high minutes
  // per occurrence, the automatable share fixed (not a confidence interval); with no estimate both
  // ends are the automatable value.
  range_per_month_x100: { low: number; high: number };
  range_cents: { low: number; high: number };
  formula: { counted: string; estimated: string | null; total: string };
  rates_sha: string;
  scoring_sha: string;
  estimates_sha: string | null;
  synthesis: null | {
    description: string;
    steps: string[];
    stalls: Array<{ summary: string; evidence_ids: string[] }>;
    contradictions: Array<{ summary: string; evidence_ids: string[] }>;
    automation: { approach: string; artifact_type: string; rationale: string };
  };
  stalls_counted: Record<StallKind, number>;
  ownership_conflicts: ConflictPair[];
  evidence_ids: string[];
  artifact: null | { type: string; path: string };
  artifact_eligible: boolean;
  flags: string[];
};

// Sums over the rows of a headline block: total = counted_email + estimated_work exactly; low and
// high the rows' range_cents; today the rows' dollars today; hours_x100 the rows' hours per month.
export type HeadlineCents = {
  total: number;
  counted_email: number;
  estimated_work: number;
  low: number;
  high: number;
  today: number;
  hours_x100: { today: number; automatable: number };
};

// out/opportunities.json (or out/opportunities.<name>.json for --rates / --estimates)
export type Opportunities = {
  version: 1;
  inputs: { rollup_sha: string; synthesis_sha: string; rates_sha: string; scoring_sha: string; estimates_sha: string | null };
  rates_file: string;
  estimates_file: string | null;
  headline: { label: 'observed in 4 mailboxes, 1999-2002'; tiers_ab_cents: HeadlineCents; all_tiers_cents: HeadlineCents };
  opportunities: Opportunity[]; // ranked by automatable cents, ties by key
  unassigned: { messages: number; slugs: number };
};

// ---- Artifacts (M6, ARCHITECTURE.md 5.9, 6.23) ----

// The artifact types a draft can have: every ArtifactType but "none", which gets no artifact.
export type DraftType = Exclude<ArtifactType, 'none'>;

// out/artifacts/index.json, written by `artifacts prepare`: the ledger's job index for the draft-
// kind. One job per eligible opportunity whose synthesis chose an artifact type, in rank order
// (draft-000 is the first of them); the other eligible opportunities are listed as skipped.
export type ArtifactIndex = {
  version: 1;
  inputs: { opportunities_sha: string; rollup_sha: string };
  jobs: Array<{
    job_id: string;
    key: string;
    rank: number;
    slug: string;
    artifact_type: DraftType;
    file: string; // "out/artifacts/input/draft-000.json": the brief
    bytes: number;
    lines: number;
    est_tokens: number;
    content_sha: string; // of the brief's text
  }>;
  skipped: Array<{ key: string; rank: number; reason: 'artifact_type none' | 'synthesis missing' }>;
};

type BriefQuote = { id: string; message_id: string; date: string | null; sender: string };

// out/artifacts/input/draft-NNN.json: the drafter's one input, under BRIEF_MAX_TOKENS by
// construction. Everything in it was counted, validated or chosen by code; the quotes are the
// validated raw spans (CRLF -> LF), which the Evidence footer prints as they are.
export type ArtifactBrief = {
  version: 1;
  job_id: string;
  key: string;
  name: string;
  slug: string;
  artifact_type: DraftType;
  definition: string;
  synthesis: { description: string; steps: string[]; stalls: string[]; contradictions: string[]; approach: string; rationale: string };
  counted: {
    label: 'facts counted by the pipeline';
    occurrences: number;
    active_months: number;
    first_day: string | null;
    last_day: string | null;
    messages: number;
    staff_participants: number;
    actions: { short: number; medium: number; long: number; forwards: number; chasers: number; reads: number };
    stalls: Record<StallKind, number>;
  };
  // No addresses; a distribution list or a system sender by its kind (and its name, when it has one).
  participants: Array<{ name: string | null; kind: PersonKind; staff: boolean; authored: number; forwards: number; chasers: number; reads: number }>;
  // Each distinct claimed person once, with whether the name matched someone who took part in the
  // process (status) and that person's display name; conflicts: the process's conflict pairs.
  ownership: { claims: Array<{ person: string; date: string | null; status: ClaimStatus; name: string | null }>; conflicts: number };
  estimate: null | {
    label: 'estimate, not a count';
    minutes_per_occurrence: { low: number; mid: number; high: number };
    automatable_pct: number;
    basis: string;
    rationale: string;
    source: 'model' | 'override';
  };
  evidence: Array<BriefQuote & { role: string; quote: string }>;
  stall_quotes: Array<BriefQuote & { kind: StallKind; quote: string }>;
  ownership_quotes: Array<BriefQuote & { person: string; quote: string }>;
};

// out/artifacts/validated/draft-NNN.json: what the gate recorded; the body stays in out/artifacts/raw/.
export type ValidatedDraft = {
  job_id: string;
  content_sha: string; // the brief's
  key: string;
  slug: string;
  artifact_type: DraftType;
  body_sha: string; // of the body with its line endings normalised
  body_bytes: number;
  headings: string[];
  blockquotes: number;
};

export type ArtifactStatus = 'done' | 'failed' | 'exhausted' | 'pending' | 'running' | 'skipped';

// out/artifacts/artifacts.json, written by `artifacts collect`: every eligible opportunity, drafted
// or not, in rank order.
export type Artifacts = {
  version: 1;
  artifacts: Array<{
    key: string;
    rank: number;
    slug: string;
    artifact_type: ArtifactType;
    status: ArtifactStatus;
    path: string | null; // the rendered artifact, when done
    dispatches: number;
    reason: string | null;
  }>;
};
