// The records `build` writes for the dashboard and the report (ARCHITECTURE.md 5.10 to 5.13). Every
// figure a page shows is a Num: the value as the pipeline stores it, the text the page places, the
// exact text one level down, its kind when it is money or hours, and where it drills to. The browser
// places these strings and computes nothing; every list is sorted by a stated key, so two builds of
// the same inputs are byte-identical.
import type { ActionType, Scoring } from '../config.ts';
import type {
  ActionCounts,
  ArtifactStatus,
  ArtifactType,
  ClaimStatus,
  ConflictPair,
  DateStatus,
  DraftType,
  MessageRole,
  PersonKind,
  ProcessWindow,
  ReplyGap,
  SegmentKind,
  StallKind,
  Tier,
} from '../types.ts';

export type Kind = 'counted' | 'estimated' | 'total';

export type CoverageBucket = 'counted' | 'unassigned' | 'personal' | 'noise' | 'automated' | 'flagged' | 'duplicates';
export type MethodSection =
  | 'rates'
  | 'tiers'
  | 'threshold'
  | 'estimates'
  | 'rounding'
  | 'identity'
  | 'flagged'
  | 'merge'
  | 'quotes'
  | 'gold'
  | 'run'
  | 'dates'
  | 'coverage'
  | 'explainer';
export type RowFilter = 'all' | 'in_total' | 'below' | 'one_mailbox' | 'drafted' | 'drafted_one_mailbox';

// Where a figure drills to (the closed list of section 4.1). Every Num carries one; the walk in
// src/report/targets.ts checks that each resolves and that a count equals the list it opens.
export type Target =
  | { kind: 'total' }
  | { kind: 'process'; key: string }
  | { kind: 'formula'; key: string }
  | { kind: 'actions'; key: string; type: ActionType | 'authored'; person?: string }
  | { kind: 'occurrences'; key: string; month?: string }
  | { kind: 'evidence'; key: string; set: 'estimate' | 'all' }
  | { kind: 'participants'; key: string; filter: 'staff' | 'writers' | 'copied' | 'all' }
  | { kind: 'stalls'; key: string; stall_kind?: StallKind }
  | { kind: 'claims'; key: string }
  | { kind: 'gaps'; key: string }
  | { kind: 'loops'; key?: string; recent?: boolean; drafted?: boolean } // drafted: the loops of processes with a drafted document
  | { kind: 'months'; key: string }
  | { kind: 'document'; key: string }
  | { kind: 'documents' }
  | { kind: 'message'; id: string; quote?: string; action?: ActionType }
  | { kind: 'thread'; id: string }
  | { kind: 'coverage'; bucket: CoverageBucket }
  | { kind: 'mailbox'; key?: string }
  | { kind: 'rows'; filter: RowFilter }
  | { kind: 'method'; section: MethodSection };

export const TARGET_KINDS = [
  'total',
  'process',
  'formula',
  'actions',
  'occurrences',
  'evidence',
  'participants',
  'stalls',
  'claims',
  'gaps',
  'loops',
  'months',
  'document',
  'documents',
  'message',
  'thread',
  'coverage',
  'mailbox',
  'rows',
  'method',
] as const satisfies ReadonlyArray<Target['kind']>;

// v: the value as the pipeline stores it (cents, hundredths, counts); t: the text shown on the page;
// x: the exact text one level down (cents, minutes); k: counted, estimated or total for money and
// hours; d: the drill target.
export type Num = { v: number; t: string; x?: string; k?: Kind; d: Target };

// One validated quote, placed: the evidence id (batch-057:e16), stall id (batch-071:s0) or claim id
// (batch-054:o0) as the synthesis input numbers them, and where the span sits in the raw message.
// Offsets index the UTF-16 units of bytes.toString('utf8') of the whole message, end exclusive.
export type QuoteRef = {
  id: string;
  kind: 'evidence' | 'stall' | 'claim';
  message_id: string;
  start: number;
  end: number;
  raw_text: string;
  match: 'exact' | 'repaired';
  segment: SegmentKind | 'subject' | null;
  field: 'body' | 'subject';
  sender: string; // the sender's canonical address
  sender_label: string; // personName of the sender
  date_utc: string | null;
  stall_kind?: StallKind;
  person?: string; // the claim's person, as written
};

export type RowDocument = { type: DraftType; status: ArtifactStatus; blanks: Num | null; reason: string | null };

export type Row = {
  rank: number;
  key: string;
  name: string;
  tier: Tier;
  tier_words: string;
  in_total: boolean;
  origin: 'taxonomy' | 'promoted';
  total: Num; // automatable cents a month; counted.t and estimated.t are whole-dollar parts of total.t
  counted: Num;
  estimated: Num;
  low: Num;
  high: Num;
  today: Num;
  hours: Num;
  hours_today: Num;
  occurrences: Num;
  shared_occurrences: number;
  active_months: Num;
  span_days: number;
  first_utc: string | null;
  last_utc: string | null;
  messages: Num;
  threads: number;
  mailboxes: Array<{ key: string; n: number; pct: number }>; // by n descending, then key
  top_mailbox: string;
  top_pct: number;
  one_mailbox: boolean; // 90% or more of its messages from one mailbox
  seen_in: string;
  staff: Num;
  writers: Num;
  copied: Num;
  estimate: null | { low: number; mid: number; high: number; automatable_pct: number; basis_words: string; source: 'model' | 'override' };
  stall_label: string;
  stall_summary: string | null;
  stall_kind: StallKind | null; // the most frequent validated stall kind
  stall_quotes: Num;
  fix: string | null;
  document: RowDocument | null;
  status_line: string;
  chasers: Num;
  stall_count: Num; // the quotes of stall_kind
  loops: Num;
  loops_recent: Num;
  claims: Num;
  conflicts: Num;
  reply_gap: null | { n: Num; median_h: string };
  last_three_months_share: Num | null; // rounds dated in the last 90 days of the top mailbox's record
  flags: string[];
};

export type MailboxScope = {
  key: string;
  owner: string;
  messages: Num;
  first_utc: string;
  last_utc: string;
  own_messages: number;
  received_only: boolean;
  rows_mostly: Num;
  rows_mostly_cents: Num;
};

export type Sentences = {
  scope: string;
  split: string;
  range: string;
  concentration: string;
  caution: string;
  threshold: string;
  sensitivity: string;
  averaging: string;
  not_included: string;
  no_reply: string;
  reading: string;
};

export type DocumentEntry = { key: string; type: DraftType | null; status: ArtifactStatus; path: string | null; blanks: Num | null; reason: string | null };

export type DashboardData = {
  version: 1;
  inputs: {
    opportunities_sha: string;
    rollup_sha: string;
    artifacts_sha: string;
    people_sha: string;
    messages_sha: string;
    threads_sha: string;
    assets_sha: string;
    config_sha: string;
    gold_sha: string; // out/gold-score.json, or the hash of "none"
    synthesizer_sha: string; // the synthesizer's model and effort, as its agent definition sets them
    run_sha: string; // the run facts' span of the run logs, up to its last step of work (the hash of "none" with no log)
  };
  outputs: Record<string, string>;
  // The run facts' span: from the latest cold run (id, date, log) through each later run that did work
  // (later_runs, a count of method.run.later_runs). minutes: v the seconds of each run from its first
  // event to its last step of work, summed; t minutes to one decimal.
  run: { id: string | null; date: string | null; minutes: Num | null; agents: Num | null; fix_rounds: Num | null; later_runs: Num | null; log: string | null };
  scope: { files: Num; unique: Num; first_utc: string; last_utc: string; mailboxes: MailboxScope[] };
  headline: {
    total: Num;
    counted: Num;
    estimated: Num;
    low: Num;
    high: Num;
    today: Num;
    hours: Num;
    hours_today: Num;
    reading: Num;
    rows_in_total: Num;
    rows_below: Num;
    below_cents: Num;
    unassigned_messages: Num;
    one_mailbox_rows: Num;
    one_mailbox_cents: Num;
    all_tiers: { total: Num; low: Num; high: Num };
    label: string;
  };
  sentences: Sentences;
  rates: {
    hourly_cents: number;
    hourly: Num; // "$85", the brief's rate, as every page and the report print it
    file: string;
    sha: string;
    minutes: Record<ActionType, number>;
    automatable_pct: Record<ActionType, number>;
    read_cap: number;
    buckets: { short_max: number; medium_max: number };
  };
  scoring: { file: string; sha: string; tiers: Scoring['tiers']; threshold_cents: number | null; threshold: Num | null; cap: number; floor: number; estimates: Scoring['estimates'] };
  chart: { y_max_cents: number; y_step_cents: number; y_max_range_cents: number; y_step_range_cents: number; drafted: number; axis_labels: string[]; axis_labels_range: string[] };
  findings: Array<{ key: string; stall_summary: string | null; stall_ids: string[]; quote: QuoteRef | null; fix: string | null }>;
  rows: Row[];
  cumulative: Array<{ key: string; cents: Num; share: Num; low_cents: number; high_cents: number }>;
  next_steps: Array<{ title: string; text: string; nums: Num[] }>;
  documents: DocumentEntry[];
};

export type LoopItem = {
  thread_id: string;
  message_id: string;
  why: 'chase' | 'waiting';
  date_utc: string | null;
  mailbox: string;
  mailbox_end_utc: string | null;
  days_before_end: number | null;
  recent: boolean;
  subject: string;
  from: string;
  from_label: string;
  thread_length: number;
  processes: string[]; // the keys the thread's messages are counted under, in rank order
  quote: QuoteRef | null;
};

export type ProcessDocument = {
  type: DraftType;
  status: ArtifactStatus;
  path: string | null;
  markdown: string | null;
  blanks: Num | null;
  blank_items: string[];
  reason: string | null;
};

export type Claim = { message_id: string; person: string; date_utc: string | null; status: ClaimStatus; status_words: string; name: string | null; people: string[]; quote: QuoteRef };

export type ProcessData = {
  key: string;
  name: string;
  definition: string;
  rank: number;
  tier: Tier;
  row: Row;
  synthesis: null | { description: string; steps: string[]; approach: string; rationale: string; artifact_type: ArtifactType };
  formula: { counted: string; estimated: string | null; total: string };
  window: ProcessWindow;
  months: number; // the window in hundredths of a month
  occurrence_share_x100: number;
  actions: { priced: ActionCounts; unpriced: ActionCounts };
  action_table: Array<{ type: ActionType; words: string; count: Num; minutes_each: number; minutes: string; automatable_pct: number; automatable_minutes: string }>;
  email: { today_x100: number; automatable_x100: number; per_month_today_x100: number; per_month_automatable_x100: number };
  work: null | { per_month_today_x100: number; per_month_automatable_x100: number; low_cents: number; high_cents: number };
  estimate_quotes: QuoteRef[];
  estimate_check: null | { occurrences_cited: number; senders_cited: number };
  monthly: Array<{ month: string; occurrences: Num; messages: number; ids: string[] }>;
  occurrences: Array<{ id: string; message_ids: string[]; date_utc: string | null }>;
  undated_occurrences: string[];
  action_sources: Array<{ message_id: string; type: ActionType; person: string; address: string; priced: boolean; share_x100: number }>;
  participants: Array<{
    email: string;
    name: string | null;
    label: string;
    kind: PersonKind;
    addresses: string[];
    staff: boolean;
    authored: number;
    forwards: number;
    chasers: number;
    reads: number;
    wrote: boolean;
  }>;
  stalls_by_kind: Array<{ kind: StallKind; words: string; count: Num }>;
  stall_groups: Array<{ summary: string; quotes: QuoteRef[] }>;
  stall_quotes: QuoteRef[];
  evidence: QuoteRef[]; // every accepted evidence quote of the process, by id
  chasers: string[];
  reply_gaps: ReplyGap[];
  reply_gap_n: number;
  median_reply_gap_h: number | null;
  claims: Claim[];
  conflicts: ConflictPair[];
  contradictions: Array<{ summary: string; quotes: QuoteRef[]; claims: Array<{ message_id: string; person: string; date_utc: string | null; status: ClaimStatus; name: string | null }> }>;
  contradictions_dropped: number;
  loops: LoopItem[];
  document: ProcessDocument | null;
};

export type MessageIndexRow = {
  id: string;
  mailbox: string;
  folder: string;
  date_utc: string | null;
  date_status: DateStatus;
  from: string;
  from_name: string | null;
  subject: string;
  recipients: number;
  thread_id: string | null;
  occurrence_id: string | null;
  duplicate_of: string | null;
  role: MessageRole | null;
  processes: string[];
  flags: string[];
};

export type MethodData = {
  version: 1;
  coverage: Array<{ bucket: CoverageBucket; words: string; count: Num; ids: string[] }>;
  unassigned_slugs: Array<{ slug: string; messages: number; status: string; reason: string | null }>;
  identity: {
    folds: Array<{ rule: string; words: string; count: Num; items: Array<{ email: string; canonical: string; name: string | null }> }>;
    left_apart: { ambiguous: string[]; no_initial: string[]; shared_message: string[]; no_candidate: string[] };
    lists: string[];
    system: string[];
    stats: { folds: Record<string, number>; ambiguous: number; lists: number; system: number };
  };
  merge: {
    counts: Record<string, number>;
    sentence: string;
    promoted: Array<{ key: string; name: string; aliases: string[]; messages: number; occurrences: number; threads: number; active_months: number }>;
    slugs: Array<{ slug: string; messages: number; batches: number; status: string; to: string | null; reason: string | null }>;
  };
  taxonomy: Array<{ key: string; name: string; definition: string }>;
  quotes: { counts: Record<string, { exact: number; repaired: number; rejected: number }>; sentence: string; rejections: Array<{ kind: string; message_id: string; process: string | null; quote: string; reason: string | null }> };
  flagged: Array<{ message_id: string; markers: string[]; role: string | null; tags: string[]; sentence: string }>;
  dates: Array<{ message_id: string; date_raw: string | null; status: DateStatus; words: string }>;
  dedup: Array<{ canonical: string; duplicates: Array<{ id: string; rule: string; recipients_differ: boolean }> }>;
  gold: null | {
    sentence: string;
    exact: { agree: number; of: number; pct: number | null };
    overlap: { agree: number; of: number; pct: number | null };
    role: { agree: number; of: number; pct: number | null };
    mismatches: Array<{ id: string; label: { processes: string[]; role: string }; extracted: { processes: string[]; role: string } }>;
  };
  estimates: Array<{
    key: string;
    name: string;
    rank: number;
    low: number;
    mid: number;
    high: number;
    automatable_pct: number;
    basis: string;
    source: 'model' | 'override';
    occurrences_cited: number;
    senders_cited: number;
    override_file: string | null;
  }>;
  run: {
    id: string | null;
    log: string | null;
    // The later runs of the span, in order, each with its log.
    later_runs: Array<{ id: string; log: string }>;
    minutes: Num | null;
    agents: Array<{ type: string; count: number }>;
    fix_rounds: Array<{ job: string; rounds: number }>;
    stages: Array<{ name: string; ms: number; summary: string }>;
    // The synthesizer's model and effort as its agent definition sets them: configuration, the one
    // place a model is named.
    synthesizer: { model: string | null; effort: string | null };
  };
  words: { rounding: string[]; tiers: string[]; threshold: string[]; estimates: string[]; identity: string[] };
  contradictions_dropped: number;
};

// out/run-summary.json: the numbers NOTES.md is written from (plain JSON, no display strings).
export type RunSummary = {
  version: 1;
  run: { id: string | null; later_runs: string[]; wall_seconds: number | null; agents: Record<string, number>; fix_rounds: number };
  quotes: { exact: number; repaired: number; rejected: number };
  merge: Record<string, number>;
  estimates: { accepted: number; missing: number; overridden: number };
  folds: Record<string, number>;
  headline: { total_cents: number; counted_cents: number; estimated_cents: number; low_cents: number; high_cents: number; all_tiers_cents: number; hours_x100: number };
  artifacts: { drafted: number; exhausted: number; skipped: number; failed: number; pending: number };
  coverage: Record<CoverageBucket, number>;
  loops: { all: number; recent: number };
  contradictions_dropped: number;
};
