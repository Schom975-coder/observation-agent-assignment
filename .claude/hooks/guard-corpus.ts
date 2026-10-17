// PreToolUse (every tool): keep pipeline agents to their own files, and keep every tool call during
// a pipeline run away from the raw corpus. CLAUDE.md: nothing but the one corpus reader opens
// corpus/ paths; subagents read prepared batch files. The browsing copy (corpus/ plus "-view") is
// covered by the same rule.
//
// Two modes:
// - A pipeline subagent (agent_type extractor, synthesizer or drafter) gets an allowlist: only the
//   tools and paths its stage needs; everything else is denied. Agents without a list yet are
//   denied everything, so a new stage can't run unguarded.
// - Any other caller while out/ledger/run.json says a run is active gets a deny-list: any path
//   segment named corpus or its browsing copy in a path-like field is refused.
// Otherwise the hook exits at once, so development sessions are untouched. Only tool inputs are
// checked, never file contents (an extraction naturally mentions corpus/... message IDs). Fail
// closed: if the guard applies and the input can't be read, or anything throws, the call is denied.
import { posix } from 'node:path';
import { PIPELINE_AGENTS, emit, isRecord, parseInput, projectRoot, readStdin, reportFailure, str, type HookInput } from './lib.ts';
import { readRun, rootForms, withoutRoot } from '../../src/run/ledger.ts';

const RULE =
  'CLAUDE.md, "Reading messages": nothing else opens corpus/... paths directly: not the pipeline, not the dashboard, ' +
  'not subagents (the browsing copy included). Subagents read prepared batch files with Windows-safe names.';

function deny(reason: string): void {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// ---- Allowlists for pipeline agents ----

// A path the agent may touch, as a project-relative POSIX path ("out/batches/batch-000.md").
type PathRule = (rel: string) => boolean;
type Policy = { read: PathRule; write: PathRule; summary: string };

const under = (dir: string): PathRule => (rel) => rel.startsWith(`${dir}/`) && rel.length > dir.length + 1;

// One entry per pipeline agent; the synthesizer (M5) and drafter (M6) get theirs with their stage.
const POLICIES: Record<string, Policy> = {
  extractor: {
    read: (rel) => under('out/batches')(rel) || rel === 'out/taxonomy.json' || under('out/extract')(rel),
    write: (rel) => /^out\/extract\/batch-\d{3,6}\.json$/.test(rel),
    summary: 'Read of out/batches/, out/taxonomy.json and out/extract/, and Write of out/extract/batch-NNN.json',
  },
};

// Claude Code gives a subagent this tool in auto mode to deliver its final reply; it names no path.
const ALWAYS_ALLOWED = new Set(['SubagentHandback']);

// Windows and macOS file systems ignore case, so there a path is compared without it.
const caseInsensitive = (root: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(root) || process.platform === 'win32' || process.platform === 'darwin';

// The project-relative POSIX form of a tool's path, or null if it is outside the project or is
// spelled in a way that might not mean what it says (Windows drops trailing dots and spaces from
// names, ":" opens an alternate data stream, short names like OBSERV~1): those are refused.
function projectRelative(value: string, root: string, cwd: string): string | null {
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

function checkAgent(agent: string, input: HookInput, root: string): void {
  const tool = str(input.tool_name);
  if (tool !== null && ALWAYS_ALLOWED.has(tool)) return;
  const policy = POLICIES[agent];
  const who = `Guard for the ${agent} subagent`;
  if (policy === undefined) {
    deny(`${who}: no allowlist is defined for this agent yet, so every tool call is refused. ${RULE}`);
    return;
  }
  const allowed = `It may use only ${policy.summary}.`;
  if (tool !== 'Read' && tool !== 'Write') {
    deny(`${who}: the ${tool ?? 'unnamed'} tool is not allowed. ${allowed} ${RULE}`);
    return;
  }
  const toolInput = input.tool_input;
  const filePath = isRecord(toolInput) ? toolInput.file_path : undefined;
  if (typeof filePath !== 'string' || filePath === '') {
    deny(`${who}: the ${tool} call has no readable file_path, so it is refused. ${allowed} ${RULE}`);
    return;
  }
  const cwd = str(input.cwd) ?? root;
  const rel = projectRelative(filePath, root, cwd);
  const rule = tool === 'Read' ? policy.read : policy.write;
  if (rel === null || !rule(rel)) {
    const where = rel === null ? 'a path outside its own files' : rel;
    deny(`${who}: ${tool} of ${where} is not allowed. ${allowed} ${RULE}`);
  }
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
  for (const form of rootForms(root)) v = v.replace(new RegExp(escapeRegExp(form.replaceAll('\\', '/')), 'gi'), '.');
  return CORPUS_SEGMENT.test(v);
}

const CLEAR_RUN = 'If no pipeline run is in progress, clear the run marker with: node obs.mjs run end';

function checkRun(scope: string, input: HookInput | null, root: string): void {
  const tool = input === null ? null : str(input.tool_name);
  const toolInput = input === null ? undefined : input.tool_input;
  if (input === null || !isRecord(toolInput)) {
    deny(`Corpus guard (${scope}): the tool call could not be checked, so it is refused. ${RULE} ${CLEAR_RUN}`);
    return;
  }
  for (const field of FIELDS) {
    const value = toolInput[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      deny(`Corpus guard (${scope}): ${tool ?? 'the tool'} has a non-text ${field}, so the call could not be checked. ${RULE} ${CLEAR_RUN}`);
      return;
    }
    if (touchesCorpus(value, root)) {
      deny(
        `Corpus guard (${scope}): ${tool ?? 'the tool'} ${field} refers to the raw corpus. ${RULE} ` +
          `Use the pipeline's node obs.mjs commands, which read it through the corpus reader. ${CLEAR_RUN}`,
      );
      return;
    }
  }
}

// ---- Entry ----

// Why the deny-list applies to this caller, or null when it doesn't.
function runScope(raw: string, input: HookInput | null, root: string): string | null {
  try {
    if (readRun(root).active) return 'a pipeline run is active';
  } catch {
    return 'the run state out/ledger/run.json is unreadable, so a run is assumed';
  }
  // Input that isn't a JSON object may still have come from a pipeline subagent.
  if (input === null && /"agent_type"\s*:\s*"(?:extractor|synthesizer|drafter)"/.test(raw)) return 'a pipeline subagent';
  return null;
}

function check(raw: string): void {
  const input = parseInput(raw);
  const root = projectRoot(input);
  const agent = input === null ? null : str(input.agent_type);
  if (agent !== null && PIPELINE_AGENTS.includes(agent)) {
    checkAgent(agent, input as HookInput, root);
    return;
  }
  const scope = runScope(raw, input, root);
  if (scope !== null) checkRun(scope, input, root);
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
