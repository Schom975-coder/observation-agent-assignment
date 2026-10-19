// The report (ARCHITECTURE.md 5.10, spec section 9): one ReportModel, built from the same data the
// dashboard reads, rendered twice by one walk of its blocks: report.md (GitHub-flavoured Markdown)
// and report.html (self-contained: the report's CSS and two fonts inlined, no script, no external
// URL). Every figure is a Num from data.json, placed as its text (or its exact text one level down),
// so no number in the report can differ from the dashboard's. Data strings (names, prose, quotes,
// subjects, documents) go through the one escaper of each format.
import { ACTION_TYPES } from '../config.ts';
import * as F from './format.ts';
import { markdownForReport, renderMarkdownHtml } from './markdown.ts';
import { escapeHtml, escapeMd, escapeMdText } from './text.ts';
import { claimStatusWords, docTitle, kindWords, personName, stallCountWords, tierRuleWords } from './words.ts';
import type { DashboardData, LoopItem, MethodData, Num, ProcessData, QuoteRef, Row } from './types.ts';

// ---- The model ----

// sub: a small second line under a table cell's text (in Markdown, after a middle dot).
export type Inline = string | { num: Num; exact?: boolean } | { code: string } | { b: Inline[] } | { tag: string } | { sub: string };
export type TableRow = { cells: Inline[][] } | { span: Inline[] };
export type Block =
  | { kind: 'h'; level: 1 | 2 | 3 | 4; text: Inline[] }
  | { kind: 'p'; text: Inline[]; cls?: string }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'table'; head: string[]; align: Array<'l' | 'r'>; rows: TableRow[]; cls?: string }
  | { kind: 'quote'; cite: Inline[]; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'doc'; markdown: string }
  | { kind: 'hr' }
  | { kind: 'pagebreak' }
  | { kind: 'section'; cls: string; blocks: Block[] };
export type ReportModel = { title: string; blocks: Block[] };

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number): string => SMALL[n] ?? F.count(n);

const h = (level: 1 | 2 | 3 | 4, ...text: Inline[]): Block => ({ kind: 'h', level, text });
const p = (...text: Inline[]): Block => ({ kind: 'p', text });
const pc = (cls: string, ...text: Inline[]): Block => ({ kind: 'p', cls, text });
const ul = (items: Inline[][]): Block => ({ kind: 'ul', items });
const n = (num: Num): Inline => ({ num });
const nx = (num: Num): Inline => ({ num, exact: true });
const b = (...text: Inline[]): Inline => ({ b: text });
const code = (s: string): Inline => ({ code: s });
const tag = (s: string): Inline => ({ tag: s });

// Code-unit order, the same on every OS (never the locale's).
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// "a, b and c"
const andList = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function quoteBlock(q: QuoteRef): Block {
  const where = q.segment === 'quoted' ? ' · inside quoted text' : q.segment === 'forwarded' ? ' · inside forwarded text' : q.field === 'subject' ? ' · the subject line' : '';
  return { kind: 'quote', cite: [q.sender_label, `, ${F.date(q.date_utc)}${where} · `, code(q.message_id)], text: q.raw_text };
}

// The report model (sections in the order of requirements F).
export function buildReport(data: Omit<DashboardData, 'inputs' | 'outputs'>, processes: readonly ProcessData[], method: MethodData): ReportModel {
  const rows = data.rows;
  const ab = rows.filter((r) => r.in_total);
  const below = rows.filter((r) => !r.in_total);
  const H = data.headline;
  const S = data.sentences;
  const cum = new Map(data.cumulative.map((c) => [c.key, c]));
  const files = new Map(processes.map((x) => [x.key, x]));
  const mailboxes = data.scope.mailboxes;
  const ownerOf = new Map(mailboxes.map((m) => [m.key, m]));
  const title = `Recurring work in ${numberWord(mailboxes.length)} ${mailboxes.length === 1 ? 'mailbox' : 'mailboxes'}`;
  const runDate = data.run.date === null ? 'no run log' : F.date(data.run.date);
  const hourly = data.rates.hourly;
  const drafted = rows.filter((r) => r.document?.status === 'done');
  const coverage = new Map(method.coverage.map((c) => [c.bucket, c]));
  const cov = (bucket: Parameters<typeof coverage.get>[0]): Num => (coverage.get(bucket) as MethodData['coverage'][number]).count;
  const docLine = (r: Row): Inline[] =>
    r.document !== null && r.document.status === 'done' && r.document.blanks !== null ? [docTitle(r.document.type), ', ', n(r.document.blanks), ' to confirm'] : [r.status_line];

  // ---- 1. The one page ----
  const findings: Block[] = [];
  for (const f of data.findings) {
    const r = rows.find((x) => x.key === f.key) as Row;
    findings.push(
      h(4, `Rank ${r.rank}: `, r.name),
      p(b(n(r.total), ' a month'), ' (the estimates put it between ', n(r.low), ' and ', n(r.high), ') · ', n(r.hours), ' hours a month'),
      p(F.seenSentence({ occurrences: r.occurrences.v, span_days: r.span_days, active_months: r.active_months.v, first_utc: r.first_utc, last_utc: r.last_utc, messages: r.messages.v })),
      p(b('Where it stalls: '), f.stall_summary ?? 'no stall was quoted for this process.', f.stall_summary === null ? '' : ' ', f.stall_summary === null ? '' : tag('(a summary)')),
      p(b('What would fix it: '), f.fix ?? 'no approach was proposed.', f.fix === null ? '' : ' ', f.fix === null ? '' : tag('(our proposal)')),
      ...(f.quote === null ? [] : [quoteBlock(f.quote)]),
      p(b('Ready to use: '), ...docLine(r)),
    );
  }
  const top = ab.slice(0, 10);
  const topRows: TableRow[] = [];
  top.forEach((r, i) => {
    const c = cum.get(r.key);
    topRows.push({
      cells: [
        [String(r.rank)],
        [r.name, { sub: r.seen_in }],
        [n(r.total)],
        [n(r.hours)],
        c === undefined ? ['not in the total'] : [n(c.cents), ' · ', n(c.share)],
        [r.stall_label],
        r.document !== null && r.document.status === 'done' ? [docTitle(r.document.type)] : ['Not drafted'],
      ],
    });
    if (i + 1 === data.chart.drafted && i + 1 < top.length) topRows.push({ span: [b(`Documents drafted for the ${F.count(data.chart.drafted)} above this line.`), ' ', S.threshold] });
  });
  const rest = ab.length - top.length;
  const onePage: Block[] = [
    pc('client', 'Prepared for Enron'),
    h(1, title),
    pc('runline', `Run of ${runDate} · `, n(data.scope.files), ' messages read · rates at ', n(hourly), ' an hour'),
    pc('value-big', n(H.total), ' a month'),
    pc('value-label', H.label),
    pc('value-what', n(H.hours), ' hours a month of recurring work could be automated.'),
    p(S.scope),
    p(S.split, ' ', S.range),
    h(3, 'Where this comes from'),
    p(S.concentration),
    p(S.caution),
    p(
      'The mailboxes: ',
      ...mailboxes.flatMap((m, i): Inline[] => [
        i === 0 ? '' : '; ',
        m.owner,
        ', ',
        n(m.messages),
        ` messages, ${F.date(m.first_utc)} to ${F.date(m.last_utc)}`,
        m.received_only ? ' (mail received only)' : '',
      ]),
      '.',
    ),
    h(3, 'What we found'),
    p(`The three biggest: ${data.cumulative[Math.min(2, data.cumulative.length - 1)]?.cents.t ?? F.money(0, 'total')} a month together.`),
    ...findings,
    h(3, 'Every process, ranked'),
    p('By what could be automated, in dollars a month; ties by name. The top ', String(top.length), ':'),
    { kind: 'table', head: ['Rank', 'Process', 'Could be automated', 'Hours', 'Running total', 'Where it stalls', 'Document'], align: ['r', 'l', 'r', 'r', 'r', 'l', 'l'], rows: topRows },
    ...(data.chart.drafted >= top.length || data.chart.drafted === 0 ? [p(S.threshold)] : []),
    p(
      rest > 0 ? `${F.plural(rest, 'more process', 'more processes')} in the total, and ` : '',
      `${F.plural(below.length, 'process', 'processes')} seen too rarely to count ${rest > 0 ? 'are' : below.length === 1 ? 'is' : 'are'} in the full table below.`,
    ),
    h(3, 'Next steps'),
    { kind: 'ol', items: data.next_steps.map((s) => [b(s.title), ': ', s.text]) },
    pc(
      'foot',
      n(data.scope.files),
      ' messages: ',
      n(cov('counted')),
      ' counted, ',
      n(cov('unassigned')),
      ' fit no recurring process, ',
      n(cov('personal')),
      ' personal, ',
      n(cov('noise')),
      ' noise, ',
      n(cov('automated')),
      ' automated, ',
      n(cov('flagged')),
      ' flagged, ',
      n(cov('duplicates')),
      ' duplicates. ',
      n(hourly),
      ' an hour. Counted means emails and addressees priced at published minutes per action; estimated means hands-on work estimated from the cited emails.',
    ),
  ];

  // ---- 2. Where the data comes from, and its limits ----
  const ends = [...new Set(mailboxes.map((m) => m.last_utc).filter((x) => x !== ''))].sort().map((x) => F.date(x));
  const firstYear = data.scope.first_utc === '' ? null : data.scope.first_utc.slice(0, 4);
  const daysInFirstYear = firstYear === null ? 0 : Math.floor((Date.UTC(Number(firstYear), 11, 31) - Date.UTC(Number(firstYear), Number(data.scope.first_utc.slice(5, 7)) - 1, Number(data.scope.first_utc.slice(8, 10)))) / 86_400_000) + 1;
  const where: Block[] = [
    h(2, 'Where the data comes from, and its limits'),
    p(`Every message in ${numberWord(mailboxes.length)} ${mailboxes.length === 1 ? 'mailbox' : 'mailboxes'} was read, ${F.date(data.scope.first_utc)} to ${F.date(data.scope.last_utc)}. `, S.concentration),
    {
      kind: 'table',
      head: ['Mailbox', 'Messages', 'First', 'Last', 'Own mail', 'Processes 90%+ from it', 'Their total a month'],
      align: ['l', 'r', 'l', 'l', 'l', 'r', 'r'],
      rows: mailboxes.map((m) => ({
        cells: [[m.owner], [n(m.messages)], [F.date(m.first_utc)], [F.date(m.last_utc)], [m.received_only ? `received only: ${F.count(m.own_messages)} sent by the owner` : `${F.count(m.own_messages)} sent by the owner`], [n(m.rows_mostly)], [n(m.rows_mostly_cents)]],
      })),
    },
    p(`The ${numberWord(mailboxes.length)} records stop on different days: ${andList(ends)}.`),
    ...mailboxes
      .filter((m) => m.received_only)
      .map((m) =>
        p(
          `${m.owner}’s mailbox holds almost only mail received: ${F.count(m.own_messages)} of its `,
          n(m.messages),
          ` messages were sent by ${m.owner}. A request with no visible reply there may have been answered.`,
        ),
      ),
    ...(firstYear === null ? [] : [p(`The record starts on ${F.date(data.scope.first_utc)}, so ${F.plural(daysInFirstYear, 'day')} of it ${daysInFirstYear === 1 ? 'falls' : 'fall'} in ${firstYear}.`)]),
    p(S.no_reply),
    p('What the mail cannot see: phone calls, conversations at the desk, and spreadsheets that were never sent.'),
    p('Mail from more people would show whether the same work happens elsewhere, and would firm up the processes seen in one mailbox only.'),
  ];

  // ---- 3. All ranked ----
  const all: Block[] = [
    h(2, `All ${F.count(rows.length)} recurring processes, ranked`),
    p(
      `By what could be automated, in dollars a month; ties by name. ${F.count(ab.length)} are in the `,
      n(H.total),
      ` total. ${F.count(below.length)} ${below.length === 1 ? 'was' : 'were'} seen too rarely to count and ${below.length === 1 ? 'sits' : 'sit'} in rank order, marked, outside the total.`,
    ),
    {
      kind: 'table',
      cls: 'full',
      head: ['Rank', 'Process', 'Counted', 'Estimated', 'Total', 'Range', 'Hours', 'Seen', 'Where seen', 'Document', 'Running total'],
      align: ['r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l', 'r'],
      rows: rows.map((r) => {
        const c = cum.get(r.key);
        return {
          cells: [
            [String(r.rank)],
            r.in_total ? [r.name] : [r.name, ' ', tag('(not in the total)')],
            [n(r.counted)],
            [n(r.estimated)],
            [n(r.total)],
            r.estimate === null ? ['no estimate'] : [n(r.low), ' to ', n(r.high)],
            [n(r.hours)],
            [n(r.occurrences), ', ', n(r.active_months)],
            [r.seen_in],
            r.document !== null && r.document.status === 'done' ? [docTitle(r.document.type)] : ['Not drafted'],
            c === undefined ? ['not in the total'] : [n(c.cents), ' · ', n(c.share)],
          ],
        };
      }),
    },
    ul((['A', 'B', 'C'] as const).map((t) => [tierLine(t, rows)])),
  ];

  // ---- 4. One section per drafted process ----
  const perProcess: Block[] = drafted.flatMap((r) => processSection(r, files.get(r.key) as ProcessData, data, ownerOf));

  // ---- 5. Why the rows below the line got no document ----
  const undrafted = ab.filter((r) => r.document?.status !== 'done');
  const why: Block[] = [
    h(2, 'Why the rows below the line got no document'),
    p(S.threshold),
    p(S.sensitivity, ' ', method.words.threshold[2] ?? ''),
    ...(undrafted.length === 0 ? [] : [ul(undrafted.map((r) => [`Rank ${r.rank}, `, r.name, ': ', r.status_line, '.']))]),
    p(`The ${F.plural(below.length, 'process', 'processes')} seen too rarely to count ${below.length === 1 ? 'is' : 'are'} ranked in the full table and ${below.length === 1 ? 'gets' : 'get'} no document: ${below.length === 1 ? 'it is' : 'they are'} not in the total.`),
  ];

  // ---- 6. How the numbers are made ----
  const R = data.rates;
  const minuteLine = ACTION_TYPES.map((t) => `${({ authored_short: 'short email written', authored_medium: 'medium', authored_long: 'long', forward: 'forward', chaser: 'chaser', read: 'read' } as const)[t]} ${R.minutes[t]}`).join(', ');
  const synth = method.run.synthesizer;
  const est = method.words.estimates;
  const docs = data.documents;
  const how: Block[] = [
    h(2, 'How the numbers are made'),
    h(3, 'Rates'),
    ul([
      [n(hourly), ' an hour, the brief’s blended rate.'],
      [`Published minutes per email action: ${minuteLine} per staff addressee (up to ${F.count(R.read_cap)} a message).`],
      [`Automatable shares: ${ACTION_TYPES.map((t) => `${R.automatable_pct[t]}%`).join(', ')}, in the same order.`],
      [`A written email is short up to ${F.count(R.buckets.short_max)} characters of the sender’s own text, medium up to ${F.count(R.buckets.medium_max)}, long beyond.`],
      ['Rates file ', code(R.file), ', hash ', code(R.sha), '.'],
      ['Scoring file ', code(data.scoring.file), ', hash ', code(data.scoring.sha), '.'],
    ]),
    h(3, 'The counting bar'),
    ul(method.words.tiers.map((w) => [w])),
    h(3, 'The drafting rule'),
    ul(method.words.threshold.map((w) => [w])),
    ...(docs.length === 0
      ? []
      : [
          {
            kind: 'table' as const,
            head: ['Rank', 'Process', 'Document', 'Blanks', 'Status'],
            align: ['r', 'l', 'l', 'r', 'l'] as Array<'l' | 'r'>,
            rows: docs.map((d) => {
              const r = rows.find((x) => x.key === d.key);
              return { cells: [[String(r?.rank ?? '')], [r?.name ?? d.key], [d.type === null ? 'none' : docTitle(d.type)], d.blanks === null ? ['none'] : [n(d.blanks)], [r?.status_line ?? d.status]] };
            }),
          },
        ]),
    h(3, 'Estimates'),
    ul([
      [est[0] ?? ''],
      [
        'Proposed once by the synthesizer agent',
        ...(synth.model === null && synth.effort === null
          ? []
          : [' (', ...(synth.model === null ? [] : ['model ', code(synth.model)]), synth.model !== null && synth.effort !== null ? ', ' : '', ...(synth.effort === null ? [] : ['effort ', code(synth.effort)]), ', set in its agent definition)']),
        (est[1] ?? '').replace(/^Proposed once by .*?\) from |^Proposed once by the synthesizer agent from /, ' from '),
      ],
      [est[2] ?? ''],
      [est[3] ?? ''],
    ]),
    ...(method.estimates.length === 0
      ? []
      : [
          {
            kind: 'table' as const,
            head: ['Rank', 'Process', 'Minutes a round (low, middle, high)', 'Automatable', 'Basis', 'Rounds cited', 'Senders cited'],
            align: ['r', 'l', 'r', 'r', 'l', 'r', 'r'] as Array<'l' | 'r'>,
            rows: method.estimates.map((e) => ({
              cells: [[String(e.rank)], [e.name], [`${e.low}, ${e.mid}, ${e.high}`], [`${e.automatable_pct}%`], [e.basis], [String(e.occurrences_cited)], [String(e.senders_cited)]],
            })),
          },
        ]),
    h(3, 'Rounding'),
    ul([...method.words.rounding.map((w) => [w]), [S.averaging]]),
    h(3, 'People'),
    ul(method.words.identity.map((w) => [w])),
    ...method.identity.folds
      .filter((f) => f.items.length > 0)
      .map((f) => p(b(`${f.count.t} by ${f.words}: `), ...f.items.flatMap((x, i): Inline[] => [i === 0 ? '' : ', ', x.email, ' into ', x.canonical]), '.')),
    ...(['ambiguous', 'no_initial', 'shared_message', 'no_candidate'] as const)
      .filter((k) => method.identity.left_apart[k].length > 0)
      .map((k) =>
        p(
          b(
            `Left apart, ${({ ambiguous: 'several candidates', no_initial: 'no middle initial to confirm the one candidate', shared_message: 'the two share a message', no_candidate: 'no candidate' } as const)[k]}: `,
          ),
          ...method.identity.left_apart[k].flatMap((e, i): Inline[] => [i === 0 ? '' : ', ', e]),
          '.',
        ),
      ),
    ...(method.identity.lists.length === 0 ? [] : [p(b(`${F.plural(method.identity.lists.length, kindWords.list)}: `), ...method.identity.lists.flatMap((e, i): Inline[] => [i === 0 ? '' : ', ', e]), '.')]),
    ...(method.identity.system.length === 0 ? [] : [p(b(`${F.plural(method.identity.system.length, kindWords.system)}: `), ...method.identity.system.flatMap((e, i): Inline[] => [i === 0 ? '' : ', ', e]), '.')]),
  ];

  // ---- 7. What was not counted ----
  const notCounted: Block[] = [
    h(2, 'What was not counted'),
    p(
      n(data.scope.files),
      ' = ',
      ...method.coverage.flatMap((c, i): Inline[] => [i === 0 ? '' : ' + ', n(c.count), ` ${c.bucket === 'unassigned' ? 'fit no recurring process' : c.bucket}`]),
      '.',
    ),
    ul(method.coverage.map((c) => [n(c.count), ` ${c.bucket}: `, c.words])),
    p(`The messages that fit no recurring process carry ${F.plural(method.unassigned_slugs.length, 'proposed process name')} the merge did not keep. ${method.merge.sentence}`),
    ...method.flagged.map((f) => p(code(f.message_id), ': ', f.sentence, f.markers.length === 0 ? '' : ` The scanner found ${F.plural(f.markers.length, 'marker')} in it.`)),
    ...(method.dates.length === 0
      ? []
      : [
          p(`${F.plural(method.dates.length, 'message')} without a usable date, counted but outside every window:`),
          ul(method.dates.map((d) => [code(d.message_id), `: ${d.words}`, ...(d.date_raw === null ? ['.'] : [', written “', d.date_raw, '”.'])])),
        ]),
    p(`${F.plural(method.dedup.reduce((x, g) => x + g.duplicates.length, 0), 'copy', 'copies')} in ${F.plural(method.dedup.length, 'group')} ${method.dedup.length === 1 ? 'was' : 'were'} counted once, as ${method.dedup.length === 1 ? 'its original' : 'their originals'}.`),
  ];

  // ---- 8. Run facts ----
  const run = method.run;
  const facts: Block[] = [
    h(2, 'Run facts'),
    ul([
      run.id === null
        ? ['No run log was found.']
        : ['Run ', code(run.id), ` of ${runDate}`, ...(data.run.later_runs === null || run.later_runs.length === 0 ? ['.'] : [', continued in ', n(data.run.later_runs), ` later ${run.later_runs.length === 1 ? 'run' : 'runs'}.`])],
      ...(run.minutes === null
        ? []
        : [
            [
              n(run.minutes),
              run.later_runs.length === 0
                ? ' minutes from the run’s first event to its last step of work (an agent started, a gate, a stage step); builds are not counted.'
                : ' minutes: each run from its first event to its last step of work (an agent started, a gate, a stage step), added up, so the wait between runs and the builds are not counted.',
            ],
          ]),
      [
        `Agents launched: ${data.run.agents?.t ?? '0'}`,
        run.agents.length === 0 ? '.' : ` (${run.agents.map((a) => `${F.plural(a.count, a.type)}`).join(', ')}).`,
      ],
      [`Fix rounds: ${data.run.fix_rounds?.t ?? '0'}`, run.fix_rounds.length === 0 ? '.' : ` (${run.fix_rounds.map((x) => `${x.job} ${x.rounds}`).join(', ')}).`],
      [method.quotes.sentence],
      [method.gold === null ? 'Tagging accuracy: not scored.' : `Tagging accuracy against the hand labels: ${method.gold.sentence}`],
      ...(run.log === null
        ? []
        : run.later_runs.length === 0
          ? [['The run’s log: ', code(run.log), '.']]
          : [['The runs’ logs: ', ...[run.log, ...run.later_runs.map((r) => r.log)].flatMap((l, i) => [i === 0 ? '' : ', ', code(l)]), '.']]),
    ]),
    ...(run.stages.length === 0
      ? []
      : [{ kind: 'table' as const, head: ['Step', 'Milliseconds', 'What it said'], align: ['l', 'r', 'l'] as Array<'l' | 'r'>, rows: run.stages.map((s) => ({ cells: [[s.name], [F.count(s.ms)], [s.summary]] })) }]),
  ];

  return {
    title,
    blocks: [{ kind: 'section', cls: 'page-one', blocks: onePage }, { kind: 'pagebreak' }, ...where, ...all, ...perProcess, ...why, ...how, ...notCounted, ...facts],
  };

  function tierLine(t: 'A' | 'B' | 'C', rs: readonly Row[]): string {
    const count = rs.filter((x) => x.tier === t).length;
    const words = tierRuleWords(t, data.scoring.tiers);
    return `${F.plural(count, 'process', 'processes')}: ${words}${words.endsWith('.') ? '' : '.'}`;
  }
}

// Section 4, one drafted process.
function processSection(r: Row, f: ProcessData, data: Omit<DashboardData, 'inputs' | 'outputs'>, ownerOf: ReadonlyMap<string, DashboardData['scope']['mailboxes'][number]>): Block[] {
  const out: Block[] = [h(2, `Rank ${r.rank}: `, r.name)];
  out.push(
    p(b(n(r.total), ' a month'), ' = ', n(r.counted), ' of email time counted + ', n(r.estimated), ' of hands-on work estimated.'),
    p('That is ', n(r.hours), ' hours a month.', r.estimate === null ? '' : ' The estimates put it between ', ...(r.estimate === null ? [] : [n(r.low), ' and ', n(r.high), '.'])),
    p(r.seen_in, '.'),
  );
  if (f.synthesis !== null) {
    out.push(h(3, 'Summary'), p(tag('A summary, written by the run from the cited emails.')), p(f.synthesis.description), p(b('The steps, as the emails show them:')), { kind: 'ol', items: f.synthesis.steps.map((s) => [s]) });
  }
  // How often.
  out.push(
    h(3, 'How often'),
    p(F.seenSentence({ occurrences: r.occurrences.v, span_days: r.span_days, active_months: r.active_months.v, first_utc: r.first_utc, last_utc: r.last_utc, messages: r.messages.v })),
    p('Rounds by month: ', ...f.monthly.flatMap((m, i): Inline[] => [i === 0 ? '' : ', ', `${F.monthShort(m.month)} `, n(m.occurrences)]), '.'),
    p('Mailboxes: ', r.mailboxes.map((m) => `${ownerOf.get(m.key)?.owner ?? m.key} ${F.count(m.n)} (${m.pct}%)`).join(', '), '.'),
  );
  if (r.last_three_months_share !== null) {
    const owner = ownerOf.get(r.top_mailbox)?.owner ?? r.top_mailbox;
    out.push(p(n(r.last_three_months_share), ` rounds fall in the last three months of ${owner}’s record.`));
  }
  // People.
  // Who writes most first: written, forwarded and chased together, then by name.
  const sent = (x: ProcessData['participants'][number]) => x.authored + x.forwards + x.chasers;
  const writers = f.participants.filter((x) => x.staff && x.wrote).sort((a, c) => sent(c) - sent(a) || byText(a.label, c.label));
  const copied = f.participants.filter((x) => x.staff && !x.wrote);
  const lists = f.participants.filter((x) => x.kind !== 'person');
  const outside = f.participants.filter((x) => x.kind === 'person' && !x.staff);
  out.push(
    h(3, 'People'),
    p(n(r.staff), ' on the threads, of whom ', n(r.writers), ' wrote. Who writes most is counted here; ownership is under “Named as owner”.'),
  );
  if (writers.length > 0) {
    out.push({
      kind: 'table',
      head: ['Wrote', 'Written', 'Forwarded', 'Chasers', 'Read'],
      align: ['l', 'r', 'r', 'r', 'r'],
      rows: writers.map((x) => ({ cells: [[x.label], [F.count(x.authored)], [F.count(x.forwards)], [F.count(x.chasers)], [F.count(x.reads)]] })),
    });
  }
  if (copied.length > 0) out.push(p(b('Copied, reading only:'), ' ', n(r.copied), ' staff: ', copied.map((x) => x.label).join(', '), '.'));
  if (lists.length + outside.length > 0) {
    out.push(
      p(
        'Not counted as staff: ',
        [
          ...lists.map((x) => `${x.email} (${kindWords[x.kind]})`),
          ...outside.map((x) => `${x.label}${x.label === x.email ? '' : ` (${x.email})`}`),
        ].join('; '),
        '.',
      ),
    );
  }
  // Where it stalls.
  const kinds = f.stalls_by_kind.map((k) => stallCountWords(k.kind, k.count.v)).join(', ');
  out.push(
    h(3, 'Where it stalls'),
    p(n(r.stall_quotes), kinds === '' ? '.' : `: ${kinds}.`, ' ', n(r.chasers), ' sent.'),
    r.reply_gap === null ? p('Reply gap not shown: fewer than 5 replies measured.') : p('Replies measured: ', n(r.reply_gap.n), `; typical wait ${r.reply_gap.median_h} hours.`),
  );
  for (const g of f.stall_groups) {
    out.push(p(tag('Summary: '), g.summary));
    for (const q of g.quotes.slice(0, 3)) out.push(quoteBlock(q));
  }
  for (const c of f.contradictions) {
    out.push(p(tag('Where the mail disagrees, a summary: '), c.summary));
    for (const q of c.quotes.slice(0, 3)) out.push(quoteBlock(q));
    for (const cl of c.claims) out.push(p(`Named as owner: “`, cl.person, `”, ${F.date(cl.date_utc)}, ${cl.status === 'matched' && cl.name !== null ? `matched to ${personName(cl.name, '')}` : claimStatusWords[cl.status]}.`));
  }
  // Named as owner.
  out.push(h(3, 'Named as owner'));
  if (f.claims.length === 0) out.push(p('No one is named as owner in these emails.'));
  for (const c of f.claims) {
    out.push(p(b(c.name === null ? c.person : personName(c.name, '')), `, named on ${F.date(c.date_utc)}: ${c.status_words}.`), quoteBlock(c.quote));
  }
  for (const pair of f.conflicts) {
    out.push(p(`Two different people named within ${F.plural(pair.days_apart, 'day')}: `, code(pair.a), ' and ', code(pair.b), '.'));
  }
  // Waiting and open loops.
  const loops = [...f.loops].sort((a, b2) => Number(b2.recent) - Number(a.recent) || byText(b2.date_utc ?? '', a.date_utc ?? ''));
  out.push(h(3, 'Waiting and open loops'), p(n(r.loops), ', ', n(r.loops_recent), ' of them in the last 90 days of the mailbox’s record. ', data.sentences.no_reply));
  for (const l of loops.slice(0, 10)) out.push(...loopBlocks(l, ownerOf));
  if (loops.length > 10) out.push(p(`${F.plural(loops.length - 10, 'more open loop')} on the dashboard.`));
  const top = ownerOf.get(r.top_mailbox);
  if (top !== undefined && top.received_only) out.push(p(`${top.owner}’s replies are not in this archive. A request with no visible reply may have been answered.`));
  // The numbers.
  out.push(
    h(3, 'The numbers'),
    p(nx(r.total), ' a month = ', nx(r.counted), ' counted at published minutes + ', nx(r.estimated), ' estimated work. Today the same work costs ', nx(r.today), ' a month (', n(r.hours_today), ' hours).'),
    ...(r.estimate === null
      ? [p('No estimate passed the checks, so only the counted email is priced.')]
      : [p(`Range `, nx(r.low), ' to ', nx(r.high), `, with the work estimate at ${r.estimate.low} or ${r.estimate.high} minutes a round (middle ${r.estimate.mid}). `, F.NOT_A_CONFIDENCE_INTERVAL)]),
    p(tag('As the run wrote it:')),
    { kind: 'code', text: [f.formula.counted, f.formula.estimated, f.formula.total].filter((x): x is string => x !== null).join('\n') },
  );
  // The document.
  const d = f.document;
  if (d !== null && d.markdown !== null && d.blanks !== null) {
    out.push(
      h(3, `The document: ${docTitle(d.type)}`),
      ...(d.blank_items.length === 0 ? [p('Nothing for the owner to confirm.')] : [p(n(d.blanks), ' for the owner to confirm:'), ul(d.blank_items.map((x) => [x]))]),
      { kind: 'doc', markdown: d.markdown },
      pc('small', 'Drafted from the cited emails for the process owner to review; shown as drafted.'),
    );
  }
  return out;
}

function loopBlocks(l: LoopItem, ownerOf: ReadonlyMap<string, DashboardData['scope']['mailboxes'][number]>): Block[] {
  const owner = ownerOf.get(l.mailbox)?.owner ?? l.mailbox;
  const when = l.days_before_end === null ? 'no usable date' : `${F.date(l.date_utc)}, ${F.plural(l.days_before_end, 'day')} before the last message in ${owner}’s mailbox`;
  const out: Block[] = [
    p(b(l.subject === '' ? '(no subject)' : l.subject), ` · ${when}${l.recent ? ' (in the last 90 days of the mailbox’s record)' : ''} · `, l.why === 'chase' ? 'a chase from ' : 'waiting for an answer: ', l.from_label, ` · thread of ${F.plural(l.thread_length, 'message')} · `, code(l.message_id)),
  ];
  if (l.quote !== null) out.push(quoteBlock(l.quote));
  return out;
}

// ---- Markdown ----

// Emphasis markers hug their text: a space inside "** ... **" would stop CommonMark reading it as
// emphasis, so leading and trailing blanks go outside the markers.
function wrap(marker: string, text: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  return m[2] === '' ? text : `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function inlineMd(parts: Inline[], cell = false): string {
  return parts
    .map((x) => {
      if (typeof x === 'string') return escapeMdText(x);
      if ('num' in x) return x.exact === true && x.num.x !== undefined ? x.num.x : x.num.t;
      if ('code' in x) return `\`${x.code.replace(/`/g, "'")}\``;
      if ('b' in x) return wrap('**', inlineMd(x.b, cell));
      if ('sub' in x) return ` · ${escapeMdText(x.sub)}`;
      return wrap('_', escapeMdText(x.tag));
    })
    .join('');
}

export function renderMd(model: ReportModel): string {
  const out: string[] = [];
  const walk = (blocks: Block[]): void => {
    for (const blk of blocks) {
      switch (blk.kind) {
        case 'h':
          out.push(`${'#'.repeat(blk.level)} ${inlineMd(blk.text)}`, '');
          break;
        case 'p':
          out.push(blk.cls === 'value-big' ? `**${inlineMd(blk.text)}**` : blk.cls === 'client' ? `_${inlineMd(blk.text)}_` : inlineMd(blk.text), '');
          break;
        case 'ul':
        case 'ol':
          blk.items.forEach((it, i) => out.push(`${blk.kind === 'ul' ? '-' : `${i + 1}.`} ${inlineMd(it)}`));
          out.push('');
          break;
        case 'table': {
          out.push(`| ${blk.head.map((x) => escapeMdText(x)).join(' | ')} |`, `|${blk.align.map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`);
          for (const row of blk.rows) {
            const cells = 'span' in row ? ['', inlineMd(row.span, true), ...blk.head.slice(2).map(() => '')] : row.cells.map((c) => inlineMd(c, true));
            out.push(`| ${cells.join(' | ')} |`);
          }
          out.push('');
          break;
        }
        case 'quote':
          out.push(inlineMd(blk.cite), '');
          for (const line of blk.text.replace(/\r\n?/g, '\n').split('\n')) out.push(line.trim() === '' ? '>' : `> ${escapeMd(line)}`);
          out.push('');
          break;
        case 'code':
          out.push('```text', blk.text, '```', '');
          break;
        case 'doc':
          out.push(markdownForReport(blk.markdown, 2).trimEnd(), '');
          break;
        case 'hr':
        case 'pagebreak':
          out.push('---', '');
          break;
        case 'section':
          walk(blk.blocks);
          break;
      }
    }
  };
  walk(model.blocks);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ---- HTML ----

function inlineHtml(parts: Inline[]): string {
  return parts
    .map((x) => {
      if (typeof x === 'string') return escapeHtml(x);
      if ('num' in x) {
        const text = x.exact === true && x.num.x !== undefined ? x.num.x : x.num.t;
        return x.num.k === undefined ? escapeHtml(text) : `<span class="fig ${x.num.k}">${escapeHtml(text)}</span>`;
      }
      if ('code' in x) return `<code>${escapeHtml(x.code)}</code>`;
      if ('b' in x) return `<strong>${inlineHtml(x.b)}</strong>`;
      if ('sub' in x) return `<span class="sub">${escapeHtml(x.sub)}</span>`;
      return `<span class="tag">${escapeHtml(x.tag)}</span>`;
    })
    .join('');
}

export type ReportAssets = { css: string; fonts: Array<{ family: string; weight: string; base64: string }> };

export function renderHtml(model: ReportModel, assets: ReportAssets, ids: ReadonlySet<string> = new Set()): string {
  const out: string[] = [];
  const walk = (blocks: Block[]): void => {
    for (const blk of blocks) {
      switch (blk.kind) {
        case 'h':
          out.push(`<h${blk.level}>${inlineHtml(blk.text)}</h${blk.level}>`);
          break;
        case 'p':
          out.push(`<p${blk.cls === undefined ? '' : ` class="${escapeHtml(blk.cls)}"`}>${inlineHtml(blk.text)}</p>`);
          break;
        case 'ul':
        case 'ol':
          out.push(`<${blk.kind}>${blk.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</${blk.kind}>`);
          break;
        case 'table': {
          const cls = (i: number) => (blk.align[i] === 'r' ? ' class="r"' : '');
          const head = `<thead><tr>${blk.head.map((x, i) => `<th scope="col"${cls(i)}>${escapeHtml(x)}</th>`).join('')}</tr></thead>`;
          const body = blk.rows
            .map((row) => ('span' in row ? `<tr class="line"><td colspan="${blk.head.length}">${inlineHtml(row.span)}</td></tr>` : `<tr>${row.cells.map((c, i) => `<td${cls(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`))
            .join('');
          out.push(`<div class="tw"><table${blk.cls === undefined ? '' : ` class="${escapeHtml(blk.cls)}"`}>${head}<tbody>${body}</tbody></table></div>`);
          break;
        }
        case 'quote':
          out.push(
            `<figure class="quote"><figcaption>${inlineHtml(blk.cite)}</figcaption><blockquote>${blk.text
              .replace(/\r\n?/g, '\n')
              .split('\n')
              .map((l) => escapeHtml(l))
              .join('<br>')}</blockquote></figure>`,
          );
          break;
        case 'code':
          out.push(`<pre class="formula">${escapeHtml(blk.text)}</pre>`);
          break;
        case 'doc':
          out.push(`<div class="doc">${renderMarkdownHtml(blk.markdown, { base: 4, ids })}</div>`);
          break;
        case 'hr':
          out.push('<hr>');
          break;
        case 'pagebreak':
          out.push('<div class="pagebreak" aria-hidden="true"></div>');
          break;
        case 'section':
          out.push(`<section class="${escapeHtml(blk.cls)}">`);
          walk(blk.blocks);
          out.push('</section>');
          break;
      }
    }
  };
  walk(model.blocks);
  const faces = assets.fonts
    .map((f) => `@font-face { font-family: '${f.family}'; src: url('data:font/woff2;base64,${f.base64}') format('woff2'); font-weight: ${f.weight}; font-style: normal; font-display: swap; }`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(model.title)}</title>`,
    '<style>',
    faces,
    assets.css.replace(/\r\n?/g, '\n').trimEnd(),
    '</style>',
    '</head>',
    '<body>',
    '<div class="brandrule" aria-hidden="true"><i></i><i></i><i></i><i></i></div>',
    '<main class="report">',
    ...out,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// Every Num the report places, for the walk of src/report/targets.ts.
export function reportNums(model: ReportModel): Num[] {
  const out: Num[] = [];
  const inl = (parts: Inline[]): void => {
    for (const x of parts) {
      if (typeof x === 'string') continue;
      if ('num' in x) out.push(x.num);
      else if ('b' in x) inl(x.b);
    }
  };
  const walk = (blocks: Block[]): void => {
    for (const blk of blocks) {
      if (blk.kind === 'h' || blk.kind === 'p') inl(blk.text);
      else if (blk.kind === 'ul' || blk.kind === 'ol') blk.items.forEach(inl);
      else if (blk.kind === 'table') for (const r of blk.rows) ('span' in r ? inl(r.span) : r.cells.forEach(inl));
      else if (blk.kind === 'quote') inl(blk.cite);
      else if (blk.kind === 'section') walk(blk.blocks);
    }
  };
  walk(model.blocks);
  return out;
}

