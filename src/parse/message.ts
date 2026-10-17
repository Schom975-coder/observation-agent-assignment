// One raw message -> the ParsedMessage record every later stage reads (src/types.ts).
// Total by construction: odd input gives null or empty fields, never an exception, so a single
// strange message cannot stop a run over the whole corpus. Offsets index into the UTF-8 text of
// the whole message, headers included, with the original line endings.
import type { ParsedMessage } from '../types.ts';
import { ownChars, segmentBody } from './body.ts';
import { parseDate } from './dates.ts';
import { OVERSIZE_BODY_CHARS, injectionMarkers } from './flags.ts';
import { headerValue, isReplyOrForward, normalizeSubject, parseAddressList, splitHeaders, xFromName } from './headers.ts';

// "corpus/<mailbox>/<folder...>/<file>": the folder is everything between mailbox and file name.
function location(id: string): { mailbox: string; folder: string } {
  const parts = id.split('/');
  if (parts[0] === 'corpus') parts.shift();
  return { mailbox: parts.length > 1 ? (parts[0] ?? '') : '', folder: parts.slice(1, -1).join('/') };
}

export function parseMessage(id: string, blobSha: string, bytes: Buffer): ParsedMessage {
  const text = bytes.toString('utf8');
  const { fields, bodyStart } = splitHeaders(text);
  const dateRaw = headerValue(fields, 'date');
  const date = parseDate(dateRaw);
  const sender = parseAddressList(headerValue(fields, 'from'))[0];
  const subject = headerValue(fields, 'subject') ?? '';
  const replyOrForward = isReplyOrForward(subject);
  const { segments } = segmentBody(text, bodyStart);
  const body = text.slice(bodyStart);
  const markers = injectionMarkers(`${subject}\n${body}`);
  return {
    id,
    blob_sha: blobSha,
    ...location(id),
    message_id: headerValue(fields, 'message-id'),
    date_raw: dateRaw,
    date_utc: date.utc,
    date_status: date.status,
    // From's own display name wins; X-From fills in when From is a bare address.
    from: sender === undefined ? null : { email: sender.email, name: sender.name ?? xFromName(headerValue(fields, 'x-from')) },
    // Recipient names only from To/Cc themselves: X-To/X-cc names do not line up with the addresses.
    to: parseAddressList(headerValue(fields, 'to')),
    cc: parseAddressList(headerValue(fields, 'cc')),
    subject,
    subject_norm: normalizeSubject(subject),
    reply_or_forward_subject: replyOrForward,
    body_start: bodyStart,
    body_chars: body.length,
    segments,
    own_chars: ownChars(text, segments),
    fresh_send: !replyOrForward && segments.every((s) => s.kind === 'own'),
    flags: {
      oversize: body.length > OVERSIZE_BODY_CHARS,
      suspected_injection: markers.length > 0,
      injection_markers: markers,
    },
  };
}
