// PreToolUse (every tool): keep pipeline agents to their own files, and keep every tool call during
// a pipeline run away from the raw corpus. CLAUDE.md: nothing but the one corpus reader opens
// corpus/ paths; subagents read prepared batch files. The browsing copy (corpus/ plus "-view") is
// covered by the same rule.
//
// Two modes:
// - A pipeline subagent (agent_type extractor, taxonomist, merger, synthesizer or drafter) gets an
//   allowlist: only the tools and paths its stage needs; everything else is denied. Agents without
//   a list are denied everything, so a new stage can't run unguarded. An extractor, a synthesizer
//   or a drafter is also bound to one ledger job: the first job file it reads binds its agent_id
//   to that job, provided the job is running and no other agent holds its current dispatch
//   (out/ledger/agents/<agent_id>.json, with the dispatch it was bound under). For an extractor
//   that is a batch (out/batches/batch-NNN.md, its previous output out/extract/batch-NNN.json or its
//   problems file out/fix/batch-NNN.txt); for a synthesizer a synthesis group
//   (out/synthesis/input/synth-NNN.md, out/synthesis/raw/synth-NNN.json or out/fix/synth-NNN.txt);
//   for a drafter a draft (its brief out/artifacts/input/draft-NNN.json, its previous body
//   out/artifacts/raw/draft-NNN.md or out/fix/draft-NNN.txt). After that it may not read another job's files, and
//   it may write only its own job's output, only while that job is still running under the same
//   dispatch. The SubagentStop gate checks the job the agent is bound to, so no model text decides
//   which file is checked. The taxonomist and the merger have fixed files and no binding.
// - Any other caller while out/ledger/run.json says a run is active gets a deny-list: any path
//   segment named corpus or its browsing copy in a path-like field is refused, and so is starting
//   a subagent that is not one of the pipeline's own.
// Otherwise the hook exits at once, so development sessions are untouched. Only tool inputs are
// checked, never file contents (an extraction naturally mentions corpus/... message IDs). Fail
// closed: if the guard applies and the input can't be read, or anything throws, the call is denied.
//
// Side jobs, so the Stop hook (gate-run.ts) steers the run's orchestrator session only: a Bash call
// that starts `node obs.mjs run start` writes a claim (out/ledger/claim.json) before the command
// runs, which run start turns into the orchestrator session; and, as the fallback when no claim was
// made (hooks off when the run started, a run started by hand), the session that starts a pipeline
// subagent during a run is recorded in out/ledger/stop-gate.json.
import { posix } from 'node:path';
import {
  PIPELINE_AGENTS,
  appendRunLog,
  emit,
  isRecord,
  parseInput,
  projectRoot,
  readStdin,
  readStopGate,
  reportFailure,
  rootVariants,
  str,
  writeStopGate,
  type HookInput,
} from './lib.ts';
import {
  JOB_KINDS,
  bindAgentOutcome,
  bindingIsCurrent,
  boundJob,
  claimFile,
  kindOf,
  nowUtc,
  readJobState,
  readRun,
  rootForms,
  withoutRoot,
  writeJsonAtomic,
  type RunState,
} from '../../src/run/ledger.ts';

const RULE =
  'CLAUDE.md, "Reading messages": nothing else opens corpus/... paths directly: not the pipeline, not the dashboard, ' +
  'not subagents (the browsing copy included). Subagents read prepared batch files with Windows-safe names.';

// A run-log line that can never fail the check: the verdict matters more than its log line.
function log(root: string, record: Record<string, unknown>): void {
  try {
    appendRunLog(root, record);
  } catch {
    // the verdict stands without it
  }
}

function deny(reason: string): void {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// ---- Allowlists for pipeline agents ----

// What a project-relative POSIX path ("out/batches/batch-000.md") is to an agent: not allowed, a
// shared file, or a file of one ledger job (which the agent's binding governs).
type PathMatch = { ok: false } | { ok: true; job: string | null };
type PathRule = (rel: string) => PathMatch;
type Policy = { read: PathRule; write: PathRule; summary: string };

const NO: PathMatch = { ok: false };
const SHARED: PathMatch = { ok: true, job: null };
const exactly = (...files: string[]): PathRule => (rel) => (files.includes(rel) ? SHARED : NO);
const ofJob = (pattern: RegExp): PathRule => (rel) => {
  const m = pattern.exec(rel);
  return m === null ? NO : { ok: true, job: m[1] as string };
};
const either = (...rules: PathRule[]): PathRule => (rel) => rules.map((r) => r(rel)).find((m) => m.ok) ?? NO;

// An extractor's batch files; a synthesizer's group files; a drafter's draft files. The job ID is
// the captured part.
const BATCH_FILE = /^out\/batches\/(batch-\d{3,6})\.md$/;
const EXTRACT_FILE = /^out\/extract\/(batch-\d{3,6})\.json$/;
const BATCH_FIX_FILE = /^out\/fix\/(batch-\d{3,6})\.txt$/;
const GROUP_FILE = /^out\/synthesis\/input\/(synth-\d{3,6})\.md$/;
const SYNTHESIS_FILE = /^out\/synthesis\/raw\/(synth-\d{3,6})\.json$/;
const GROUP_FIX_FILE = /^out\/fix\/(synth-\d{3,6})\.txt$/;
const BRIEF_FILE = /^out\/artifacts\/input\/(draft-\d{3,6})\.json$/;
const DRAFT_FILE = /^out\/artifacts\/raw\/(draft-\d{3,6})\.md$/;
const DRAFT_FIX_FILE = /^out\/fix\/(draft-\d{3,6})\.txt$/;

// One entry per pipeline agent.
const POLICIES: Record<string, Policy> = {
  extractor: {
    read: either(exactly('out/taxonomy.json'), ofJob(BATCH_FILE), ofJob(EXTRACT_FILE), ofJob(BATCH_FIX_FILE)),
    write: ofJob(EXTRACT_FILE),
    summary:
      'Read of its own batch file out/batches/batch-NNN.md, its own output out/extract/batch-NNN.json, its own problems file ' +
      'out/fix/batch-NNN.txt and out/taxonomy.json, and Write of its own output out/extract/batch-NNN.json ' +
      '(its batch is the first batch file it reads)',
  },
  taxonomist: {
    read: exactly('out/taxonomy-digest.md', 'out/taxonomy-proposed.json'),
    write: exactly('out/taxonomy-proposed.json'),
    summary: 'Read of out/taxonomy-digest.md and out/taxonomy-proposed.json, and Write of out/taxonomy-proposed.json',
  },
  merger: {
    read: exactly('out/merge-input.md', 'out/taxonomy.json', 'out/merge-proposed.json'),
    write: exactly('out/merge-proposed.json'),
    summary: 'Read of out/merge-input.md, out/taxonomy.json and out/merge-proposed.json, and Write of out/merge-proposed.json',
  },
  synthesizer: {
    // Not the group's sidecar (out/synthesis/input/synth-NNN.json): the validator's, not the agent's.
    read: either(ofJob(GROUP_FILE), ofJob(SYNTHESIS_FILE), ofJob(GROUP_FIX_FILE)),
    write: ofJob(SYNTHESIS_FILE),
    summary:
      'Read of its own group input out/synthesis/input/synth-NNN.md, its own output out/synthesis/raw/synth-NNN.json and its own ' +
      'problems file out/fix/synth-NNN.txt, and Write of its own output out/synthesis/raw/synth-NNN.json ' +
      '(its group is the first group file it reads)',
  },
  drafter: {
    // Not the index, the validated record or any rendered artifact: only its own draft's files.
    read: either(ofJob(BRIEF_FILE), ofJob(DRAFT_FILE), ofJob(DRAFT_FIX_FILE)),
    write: ofJob(DRAFT_FILE),
    summary:
      'Read of its own brief out/artifacts/input/draft-NNN.json, its own body out/artifacts/raw/draft-NNN.md and its own problems file ' +
      'out/fix/draft-NNN.txt, and Write of its own body out/artifacts/raw/draft-NNN.md (its draft is the first draft file it reads)',
  },
};

// Claude Code gives a subagent this tool in auto mode to deliver its final reply; it names no path.
const ALWAYS_ALLOWED = new Set(['SubagentHandback']);

// Windows and macOS file systems ignore case, so there a path is compared without it.
const caseInsensitive = (root: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(root) || process.platform === 'win32' || process.platform === 'darwin';

// The project-relative POSIX form of a tool's path, or null if it is outside the project or is
// spelled in a way that might not mean what it says (Windows drops trailing dots and spaces from
// names, ":" opens an alternate data stream, short names like OBSERV~1): those are refused. The
// project folder may be spelled as given or resolved through links (rootVariants).
function projectRelative(value: string, root: string, cwd: string): string | null {
  for (const variant of rootVariants(root)) {
    const rel = relativeTo(value, variant, cwd);
    if (rel !== null) return rel;
  }
  return null;
}

function relativeTo(value: string, root: string, cwd: string): string | null {
  const rootSlash = root.replaceAll('\\', '/').replace(/\/+$/, '');
  let v = value.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\//.exec(rootSlash);
  const bash = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])\/(.*)$/.exec(v);
  if (drive !== null && bash !== null) v = `${(bash[1] as string).toUpperCase()}:/${bash[2]}`;
  const absolute = v.startsWith('/') || /^[A-Za-z]:\//.test(v);
  if (!absolute) v = `${cwd.replaceAll('\\', '/').replace(/\/+$/, '')}/${v}`;
  v = posix.normalize(v);
  const prefix = `${rootSlash}/`;
  const inside = caseInsensitive(root) ? v.toLowerCase().startsWith(prefix.toLowerCase()) : v.startsWith(prefix);
  if (!inside) return null;
  const rel = v.slice(prefix.length);
  if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.split('/').some((seg) => seg === '' || seg.endsWith('.') || seg.includes('~'))) return null;
  return caseInsensitive(root) ? rel.toLowerCase() : rel;
}

// What the binding messages call a job's input file and its work, by kind.
const INPUT_FILE = { batch: 'batch file', synth: 'input file', draft: 'brief' } as const;
const BEING = { batch: 'extracted', synth: 'synthesized', draft: 'drafted' } as const;

// Why an extractor, synthesizer or drafter (`agent`) may not touch this job's file, or null when it may. The
// first job file it reads binds it; a write needs that binding, the same job, and the job still
// running under the dispatch the binding recorded (a re-dispatch hands the job to a new agent).
// Which kind of job an agent may bind to is fixed by its allowlist's path patterns.
function bindingProblem(agent: string, tool: 'Read' | 'Write', jobId: string, agentId: string | null, root: string): string | null {
  const kind = kindOf(jobId);
  const { short, worker } = JOB_KINDS[kind];
  if (agentId === null || agentId === '') return `the call carries no agent_id, so it cannot be tied to one ${short}`;
  let binding = boundJob(root, agentId);
  if (binding === null) {
    if (tool === 'Write') {
      return `it has not read its ${short} yet. Read the ${INPUT_FILE[kind]} named in your task first; ${worker === 'extractor' ? 'an' : 'a'} ${worker} writes only the output of that ${short}`;
    }
    // Another Read of this agent's, in the same turn, may be binding it at this moment: only the
    // call that made the binding logs it.
    const { result: bound, created } = bindAgentOutcome(root, agentId, jobId);
    if (!bound.ok) {
      log(root, { event: 'guard_bind_refused', agent_type: agent, agent_id: agentId, batch_id: jobId, reason: bound.reason });
      return `it cannot start on ${jobId}: ${bound.reason}`;
    }
    binding = bound.binding;
    if (created) log(root, { event: 'guard_bind', agent_type: agent, agent_id: agentId, batch_id: binding.batch_id, dispatches: binding.dispatches });
  }
  if (binding.batch_id !== jobId) {
    return `it is working on ${binding.batch_id} (the first ${short} file it read), so ${tool} of ${jobId}'s files is refused`;
  }
  if (tool === 'Write') {
    const state = readJobState(root, jobId);
    if (!bindingIsCurrent(binding, state)) {
      return `${jobId} has been handed to another ${worker} since this one started, so this output is no longer used. Stop and reply in one sentence`;
    }
    if (state.status !== 'running') {
      return `${jobId} is no longer being ${BEING[kind]} (it is ${state.status}), so its output cannot change now. Stop and reply in one sentence`;
    }
  }
  return null;
}

function checkAgent(agent: string, input: HookInput, root: string): void {
  const tool = str(input.tool_name);
  if (tool !== null && ALWAYS_ALLOWED.has(tool)) return;
  const agentId = str(input.agent_id);
  const who = `Guard for the ${agent} subagent`;
  const refuse = (reason: string): void => {
    deny(`${who}: ${reason}. ${RULE}`);
    log(root, { event: 'guard_deny', agent_type: agent, agent_id: agentId, tool });
  };
  const policy = POLICIES[agent];
  if (policy === undefined) {
    refuse('no allowlist is defined for this agent yet, so every tool call is refused');
    return;
  }
  const allowed = `It may use only ${policy.summary}`;
  if (tool !== 'Read' && tool !== 'Write') {
    refuse(`the ${tool ?? 'unnamed'} tool is not allowed. ${allowed}`);
    return;
  }
  const toolInput = input.tool_input;
  const filePath = isRecord(toolInput) ? toolInput.file_path : undefined;
  if (typeof filePath !== 'string' || filePath === '') {
    refuse(`the ${tool} call has no readable file_path, so it is refused. ${allowed}`);
    return;
  }
  const cwd = str(input.cwd) ?? root;
  const rel = projectRelative(filePath, root, cwd);
  const match = rel === null ? NO : (tool === 'Read' ? policy.read : policy.write)(rel);
  if (!match.ok) {
    refuse(`${tool} of ${rel ?? 'a path outside its own files'} is not allowed. ${allowed}`);
    return;
  }
  if (match.job === null) return;
  const problem = bindingProblem(agent, tool, match.job, agentId, root);
  if (problem !== null) refuse(`${tool} of ${rel} is refused: ${problem}. ${allowed}`);
}

// ---- Deny-list during a run ----

// Every tool_input field that names a path or a command: Read/Edit/Write file_path, Grep and Glob
// pattern/path/glob, NotebookEdit notebook_path, Bash and PowerShell command.
const FIELDS = ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command'] as const;

// A path segment "corpus" or "corpus" + "-view", in any case (Windows and macOS file systems ignore
// case). Before it: start, a separator, or anything that can't be part of a name (quote, space,
// colon as in HEAD:corpus/..., =, $). After it: end, or anything that can't continue the name, so
// corpus-mini or my_corpus pass but corpus. and corpus~1 (a Windows short name) do not.
const CORPUS_SEGMENT = /(?:^|[^A-Za-z0-9_.-])corpus(?:-view)?(?=$|[^A-Za-z0-9_-])/i;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The project folder is removed first, so a checkout that happens to sit under a folder named
// corpus is not mistaken for the corpus itself.
function touchesCorpus(value: string, root: string): boolean {
  let v = value.replaceAll('\\', '/');
  const forms = [...new Set(rootVariants(root).flatMap(rootForms))].sort((a, b) => b.length - a.length);
  for (const form of forms) v = v.replace(new RegExp(escapeRegExp(form.replaceAll('\\', '/')), 'gi'), '.');
  return CORPUS_SEGMENT.test(v);
}

const CLEAR_RUN = 'If no pipeline run is in progress, clear the run marker with: node obs.mjs run end';

// The tool that starts a subagent ("Task" in older Claude Code versions).
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

// True when the call passes; otherwise the denial has been emitted.
function checkRun(scope: string, input: HookInput | null, root: string): boolean {
  const tool = input === null ? null : str(input.tool_name);
  const toolInput = input === null ? undefined : input.tool_input;
  if (input === null || !isRecord(toolInput)) {
    deny(`Corpus guard (${scope}): the tool call could not be checked, so it is refused. ${RULE} ${CLEAR_RUN}`);
    return false;
  }
  if (tool !== null && SPAWN_TOOLS.has(tool)) {
    const type = str(toolInput.subagent_type);
    if (type === null || !PIPELINE_AGENTS.includes(type)) {
      deny(
        `Corpus guard (${scope}): during a pipeline run only the pipeline's own subagents (${PIPELINE_AGENTS.join(', ')}) may be started, ` +
          `so ${type === null ? 'a subagent with no subagent_type' : `the ${type} subagent`} is refused. ${RULE} ${CLEAR_RUN}`,
      );
      return false;
    }
  }
  for (const field of FIELDS) {
    const value = toolInput[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      deny(`Corpus guard (${scope}): ${tool ?? 'the tool'} has a non-text ${field}, so the call could not be checked. ${RULE} ${CLEAR_RUN}`);
      return false;
    }
    if (touchesCorpus(value, root)) {
      deny(
        `Corpus guard (${scope}): ${tool ?? 'the tool'} ${field} refers to the raw corpus. ${RULE} ` +
          `Use the pipeline's node obs.mjs commands, which read it through the corpus reader. ${CLEAR_RUN}`,
      );
      return false;
    }
  }
  return true;
}

// ---- The orchestrator's session ----

// The fallback claim: when no session is recorded for this run yet (`run start` saw no claim:
// hooks were off when it ran, it was started by hand, or from a shell whose command the claim
// pattern does not match), the first session that starts a pipeline subagent during the run is
// its orchestrator. Once a session is recorded it stays: a second window spawning a pipeline agent
// during the run (an `/extract-batch` by hand) never takes the run over. Never in the way of the
// call: a failure is reported, and the Stop hook then steers whichever session stops.
function claimRun(input: HookInput, run: RunState, root: string): void {
  const session = str(input.session_id);
  if (session === null || session === '') return;
  try {
    const gate = readStopGate(root, run.run_id);
    if (gate.session_id !== null) return;
    writeStopGate(root, { run_id: run.run_id, session_id: session, last_block: null });
    log(root, { event: 'guard_claim', subagent_type: isRecord(input.tool_input) ? str(input.tool_input.subagent_type) : null });
  } catch (err) {
    reportFailure('guard-corpus', err, root);
  }
}

// ---- The run claim ----

// The command that starts a run, as the /observe skill types it.
const RUN_START = /^\s*node obs\.mjs run start\b/;

// A session about to run `node obs.mjs run start` claims the run before the command runs:
// out/ledger/claim.json {session_id, utc}, which run start turns into the run's orchestrator
// session (so the Stop hook steers that session, from the run's first turn). Outside a run and
// inside one alike; never in the way of the call: a failure is reported and the call goes ahead.
function claimRunStart(input: HookInput, root: string): void {
  const toolInput = input.tool_input;
  const command = isRecord(toolInput) ? str(toolInput.command) : null;
  const session = str(input.session_id);
  if (str(input.tool_name) !== 'Bash' || command === null || !RUN_START.test(command) || session === null || session === '') return;
  try {
    writeJsonAtomic(claimFile(root), { session_id: session, utc: nowUtc() });
    log(root, { event: 'guard_claim', via: 'run_start' });
  } catch (err) {
    reportFailure('guard-corpus', err, root);
  }
}

// ---- Entry ----

function check(raw: string): void {
  const input = parseInput(raw);
  const root = projectRoot(input);
  const agent = input === null ? null : str(input.agent_type);
  if (agent !== null && PIPELINE_AGENTS.includes(agent)) {
    checkAgent(agent, input as HookInput, root);
    return;
  }
  // Why the deny-list applies to this caller, if it does.
  let run: RunState | null = null;
  let scope: string | null = null;
  try {
    run = readRun(root);
    if (run.active) scope = 'a pipeline run is active';
  } catch {
    scope = 'the run state out/ledger/run.json is unreadable, so a run is assumed';
  }
  // Input that isn't a JSON object may still have come from a pipeline subagent.
  if (scope === null && input === null && new RegExp(`"agent_type"\\s*:\\s*"(?:${PIPELINE_AGENTS.join('|')})"`).test(raw)) {
    scope = 'a pipeline subagent';
  }
  if (scope !== null && !checkRun(scope, input, root)) return;
  if (input !== null) claimRunStart(input, root);
  if (scope === null) return;
  const tool = input === null ? null : str(input.tool_name);
  if (run?.active === true && input !== null && tool !== null && SPAWN_TOOLS.has(tool)) claimRun(input, run, root);
}

let raw = '';
try {
  raw = await readStdin();
  check(raw);
} catch (err) {
  // Anything thrown while checking denies; if it is unclear whether the guard applies, it applies.
  const root = projectRoot(parseInput(raw));
  reportFailure('guard-corpus', err, root);
  deny(`Corpus guard: the check failed (${withoutRoot(err instanceof Error ? err.message : String(err), root)}), so the call is refused. ${RULE}`);
}
