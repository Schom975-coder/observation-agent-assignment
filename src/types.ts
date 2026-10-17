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

// What one message counts as in the email-trail model (see ARCHITECTURE.md 4.1).
export type AuthoredAction = 'chaser' | 'forward' | 'authored_short' | 'authored_medium' | 'authored_long';

export type MessageActions = {
  id: string;
  authored: AuthoredAction;
  sender_priced: boolean; // sender's domain is a priced (company) domain
  reads: Array<{ email: string; priced: boolean }>; // distinct recipients, sender excluded, capped
};
