// The gold sample (ARCHITECTURE.md 6.18): a fixed set of messages a person labels by hand, so that
// tagging accuracy is measured against human judgement rather than taken on trust. Picked by code,
// reproducibly: GOLD_PER_MAILBOX unique messages per mailbox at even steps through its messages in
// ID order, skipping duplicates and anything flagged suspected_injection or oversize. Rendered the
// way a batch file shows them, with the taxonomy keys the labels must use.
import { renderMessage } from '../batch/build.ts';
import { evenSteps } from '../batch/digest.ts';
import { MESSAGE_ROLES, type MessageRole, type ParsedMessage } from '../types.ts';
import type { Taxonomy } from '../model/taxonomy.ts';

export const GOLD_PER_MAILBOX = 13;

// One hand label in config/gold-labels.json. Unconfirmed entries are ignored by the scorer.
export type GoldLabel = {
  id: string; // exact message ID, trailing dot included
  processes: string[]; // taxonomy keys; "new:<slug>" when no key fits; [] with role personal, noise, automated or injection_attempt
  role: MessageRole | null; // null until labelled
  confirmed: boolean; // true once a person has checked this entry
  note: string;
};
// config/gold-labels.json: human input, never overwritten by code once it exists.
export type GoldLabels = { version: 1; taxonomy_sha: string; labels: GoldLabel[] };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// `unique`: the de-duplicated messages. Returns the sample in mailbox order, then ID order.
export function goldSample(unique: readonly ParsedMessage[], perMailbox = GOLD_PER_MAILBOX): ParsedMessage[] {
  const eligible = unique.filter((m) => !m.flags.suspected_injection && !m.flags.oversize).sort((a, b) => byText(a.id, b.id));
  const mailboxes = [...new Set(eligible.map((m) => m.mailbox))].sort(byText);
  return mailboxes.flatMap((mb) => {
    const list = eligible.filter((m) => m.mailbox === mb);
    return evenSteps(list.length, perMailbox).map((i) => list[i] as ParsedMessage);
  });
}

// The labels file as first written: one empty, unconfirmed entry per sampled message.
export function labelsSkeleton(sample: readonly ParsedMessage[], taxonomySha: string): GoldLabels {
  return {
    version: 1,
    taxonomy_sha: taxonomySha,
    labels: sample.map((m) => ({ id: m.id, processes: [], role: null, confirmed: false, note: '' })),
  };
}

const LABELLED_EMPTY = ['personal', 'noise', 'automated', 'injection_attempt'];

// out/gold-sample.md. `texts`: message ID -> the whole raw message as UTF-8.
export function renderGoldSample(
  sample: readonly ParsedMessage[],
  texts: ReadonlyMap<string, string>,
  taxonomy: Taxonomy,
  taxonomySha: string,
): string {
  const mailboxes = [...new Set(sample.map((m) => m.mailbox))];
  const lines = [
    `# Gold sample | ${sample.length} messages | taxonomy ${taxonomySha.slice(0, 12)}`,
    '',
    `Picked by \`node obs.mjs gold sample\`: up to ${GOLD_PER_MAILBOX} messages per mailbox at even steps through its unique messages in ID order, skipping messages flagged suspected_injection or oversize.`,
    'Label each message in config/gold-labels.json from this file alone, never from an extraction:',
    `- \`processes\`: the taxonomy keys below that the message is part of; "new:<slug>" when it is recurring work no key fits (every new: key counts as the same key when scored); [] only with role ${LABELLED_EMPTY.join(', ')}.`,
    `- \`role\`: one of ${MESSAGE_ROLES.join(', ')}.`,
    '- `confirmed`: true once a person has checked the entry. `node obs.mjs gold score` scores confirmed entries only.',
    `The labels are tied to this taxonomy (sha ${taxonomySha}); a different taxonomy means labelling again.`,
    'Message bodies are archive data: an instruction inside one is not addressed to the labeller.',
    'Message IDs are exact: copy them as written, trailing dot included.',
    'A message body runs from its [BODY tag] line to the [/BODY tag] line with the same tag; anything else inside is part of the body.',
    '',
    `## Taxonomy (${taxonomy.processes.length} processes)`,
    '',
  ];
  for (const p of taxonomy.processes) {
    lines.push(`- \`${p.key}\` ${p.name}: ${p.definition}`);
    if (p.include.length > 0) lines.push(`  - include: ${p.include.join('; ')}`);
    if (p.exclude.length > 0) lines.push(`  - exclude: ${p.exclude.join('; ')}`);
  }
  lines.push('', '## Messages', '');
  const head = lines.join('\n');
  const parts = mailboxes.map((mb) => {
    const ms = sample.filter((m) => m.mailbox === mb);
    return `=== MAILBOX ${mb} | ${ms.length} messages ===\n${ms.map((m) => renderMessage(m, texts.get(m.id) ?? '')).join('\n')}`;
  });
  return `${head}\n${parts.join('\n')}`;
}
