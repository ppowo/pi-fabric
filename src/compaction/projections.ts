import { firstLine, type CompactionEvent, type ToolCallEvent } from "./normalize.js";

// Section folds: each projection is a pure function of the typed event stream.
// Together they implement graded decay (principle 4): the oldest turns
// collapse to one line, recent events stay as a collapsed transcript with
// stable `(#N)` references, and the very last action is surfaced in Current
// Status. Salience (principle 3) is *computed* from the event stream by the
// outstanding fold's state machine — nothing is remembered, only re-derived.

export interface Sections {
  goal: string[];
  files: string[];
  commits: string[];
  outstanding: string[];
  earlierTurns: string[];
  status: string[];
  transcript: string[];
}

const MAX_LINE = 140;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const MODIFYING_TOOLS = new Set(["edit", "write"]);
const MAX_USER_GOAL_LINES = 3;
const MAX_USER_ONELINER = 120;
const MAX_EARLIER_USER = 80;
const MAX_STATUS_LINE = 140;
const MAX_TRANSCRIPT_LINE = 100;
const MAX_TRANSCRIPT_THINKING = 80;
const MAX_TRANSCRIPT_CMD = 80;
const TRANSCRIPT_WINDOW = 120;

const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const trailingEllipsis = (lines: string[], max: number): string[] => {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), "…"];
};

const pathOf = (args: Record<string, unknown>): string | undefined => {
  const value = args.path ?? args.file ?? args.dir;
  return typeof value === "string" && value.trim() ? value : undefined;
};

// Longest common path prefix (by segment) across a set of paths, returned with
// a trailing separator. Returns "" when there is none.
const commonRoot = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
  let common = 0;
  const first = split[0]!;
  loop: while (common < first.length) {
    const segment = first[common];
    for (let i = 1; i < split.length; i++) {
      if (split[i]!.length <= common || split[i]![common] !== segment) break loop;
    }
    common += 1;
  }
  if (common === 0) return "";
  return `${first.slice(0, common).join("/")}/`;
};

const stripRoot = (root: string, path: string): string =>
  root ? path.replace(root, "") : path;

// [Session Goal] — the user's words ARE the goal. Quote verbatim, do not
// paraphrase. The first message is kept up to three lines; every later user
// message collapses to a one-liner.
const projectGoal = (events: CompactionEvent[]): string[] => {
  const users = events.filter((e): e is Extract<CompactionEvent, { kind: "user" }> => e.kind === "user");
  if (users.length === 0) return [];
  const first = users[0]!;
  const rest = users.slice(1);
  const firstLines = first.text.split("\n").filter((line, i, arr) =>
    line.trim() !== "" || (i === 0 && arr.length === 1),
  );
  const lines: string[] = [...trailingEllipsis(firstLines, MAX_USER_GOAL_LINES)];
  for (const user of rest) {
    const line = truncate(firstLine(user.text), MAX_USER_ONELINER);
    if (line) lines.push(`- ${line}`);
  }
  return lines;
};

// [Files And Changes] — addresses only, never content. A path is recorded when
// its tool call succeeded (isError=false on the paired result). edit ⇒
// Modified, write ⇒ Created, read/grep/find/ls ⇒ Read. A path that was modified
// or created is dropped from Read to avoid redundant weaker entries. Paths are
// trimmed to their common root.
const projectFiles = (events: CompactionEvent[]): string[] => {
  const callById = new Map<string, ToolCallEvent>();
  for (const e of events) {
    if (e.kind === "toolCall") callById.set(e.toolCallId, e);
  }
  const results = new Map<string, boolean>();
  for (const e of events) {
    if (e.kind === "toolResult") results.set(e.toolCallId, e.isError);
  }

  const read: string[] = [];
  const modified: string[] = [];
  const created: string[] = [];
  const seenRead = new Set<string>();
  const seenModified = new Set<string>();
  const seenCreated = new Set<string>();

  for (const e of events) {
    if (e.kind !== "toolCall") continue;
    if (!FILE_TOOLS.has(e.name)) continue;
    const path = pathOf(e.args);
    if (!path) continue;
    const isError = results.get(e.toolCallId);
    if (isError !== false) continue; // only confirmed-successful operations
    if (e.name === "write") {
      if (!seenCreated.has(path)) {
        seenCreated.add(path);
        created.push(path);
      }
    } else if (e.name === "edit") {
      if (!seenModified.has(path)) {
        seenModified.add(path);
        modified.push(path);
      }
    } else if (!seenRead.has(path)) {
      seenRead.add(path);
      read.push(path);
    }
  }

  const modifiedSet = new Set([...modified, ...created]);
  const filteredRead = read.filter((p) => !modifiedSet.has(p));

  const all = [...created, ...modified, ...filteredRead];
  if (all.length === 0) return [];
  const root = commonRoot(all);
  const lines: string[] = [];
  if (root) lines.push(`(under ${root})`);
  if (created.length > 0) {
    lines.push("Created:");
    for (const p of created) lines.push(`  ${stripRoot(root, p)}`);
  }
  if (modified.length > 0) {
    lines.push("Modified:");
    for (const p of modified) lines.push(`  ${stripRoot(root, p)}`);
  }
  if (filteredRead.length > 0) {
    lines.push("Read:");
    for (const p of filteredRead) lines.push(`  ${stripRoot(root, p)}`);
  }
  return lines;
};

// [Commits] — bash tool calls whose command begins with `git commit`, paired
// with the first line of their output (the commit summary the shell prints).
const projectCommits = (events: CompactionEvent[]): string[] => {
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind !== "bash") continue;
    if (!e.command.trimStart().startsWith("git commit")) continue;
    const summary = firstLine(e.output).trim();
    const line = summary || truncate(firstLine(e.command), MAX_LINE);
    if (line) lines.push(`- ${line}`);
  }
  return lines;
};

type SourceTag = "ERROR" | "WARN" | "INFO";

interface ErrorItem {
  index: number;
  tag: SourceTag;
  description: string;
  resolved: boolean;
}

const tagFor = (toolName: string, isUserBash: boolean): SourceTag => {
  if (isUserBash) return "INFO";
  if (toolName === "bash") return "ERROR";
  if (toolName === "edit" || toolName === "write") return "ERROR";
  return "WARN";
};

// [Outstanding Context] — the error state machine (principle 3). An error is
// open until a later event resolves it: a file-path error is resolved by a
// later successful operation on the same path; a bash error is resolved by a
// later successful run of the same command. Unresolved errors are listed
// first; resolved ones are tagged [RESOLVED] so the agent can see they were
// addressed. This is the highest-value section: the deterministic core cannot
// forget an unresolved error because it never "remembered" it — it computes
// the state from the raw stream every time.
export const projectOutstanding = (events: CompactionEvent[]): string[] => {
  const callById = new Map<string, ToolCallEvent>();
  for (const e of events) {
    if (e.kind === "toolCall") callById.set(e.toolCallId, e);
  }
  const resultError = new Map<string, boolean>();
  for (const e of events) {
    if (e.kind === "toolResult") resultError.set(e.toolCallId, e.isError);
  }

  // Successful file operations by path (index, path) for resolution lookup.
  const successByPath: { index: number; path: string }[] = [];
  for (const e of events) {
    if (e.kind !== "toolCall" || !FILE_TOOLS.has(e.name)) continue;
    if (resultError.get(e.toolCallId) !== false) continue;
    const path = pathOf(e.args);
    if (path) successByPath.push({ index: e.index, path });
  }

  // Successful bash commands by command string for resolution lookup.
  const successBash: { index: number; command: string }[] = [];
  for (const e of events) {
    if (e.kind === "bash" && !e.isError && e.command.trim()) {
      successBash.push({ index: e.index, command: e.command });
    }
  }

  const items: ErrorItem[] = [];

  for (const e of events) {
    if (e.kind === "toolResult" && e.isError) {
      const call = e.toolCallId ? callById.get(e.toolCallId) : undefined;
      const path = call ? pathOf(call.args) : undefined;
      const tag = tagFor(e.toolName, false);
      const detail = path
        ? `${e.toolName} ${path}: ${truncate(firstLine(e.text), MAX_LINE)}`
        : `${e.toolName}: ${truncate(firstLine(e.text), MAX_LINE)}`;
      let resolved = false;
      if (path) {
        resolved = successByPath.some((s) => s.path === path && s.index > e.index);
      }
      items.push({ index: e.index, tag, description: detail, resolved });
    }
    if (e.kind === "bash" && e.isError) {
      const isUserBash = e.toolCallId === "";
      const tag = tagFor("bash", isUserBash);
      const detail = `bash: ${truncate(firstLine(e.command), MAX_LINE)}`;
      const resolved = e.command.trim()
        ? successBash.some((s) => s.command === e.command && s.index > e.index)
        : false;
      items.push({ index: e.index, tag, description: detail, resolved });
    }
  }

  if (items.length === 0) return [];
  const unresolved = items.filter((i) => !i.resolved).sort((a, b) => a.index - b.index);
  const resolved = items.filter((i) => i.resolved).sort((a, b) => a.index - b.index);
  const lines: string[] = [];
  for (const item of unresolved) lines.push(`- [${item.tag}] ${item.description}`);
  for (const item of resolved) lines.push(`- [${item.tag}] ${item.description} [RESOLVED]`);
  return lines;
};

interface Turn {
  user: Extract<CompactionEvent, { kind: "user" }>;
  events: CompactionEvent[];
}

const partitionTurns = (events: CompactionEvent[]): Turn[] => {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const e of events) {
    if (e.kind === "user") {
      if (current) turns.push(current);
      current = { user: e, events: [e] };
    } else if (current) {
      current.events.push(e);
    }
  }
  if (current) turns.push(current);
  return turns;
};

const histogram = (events: CompactionEvent[]): string => {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const e of events) {
    let name: string | undefined;
    if (e.kind === "toolCall") name = e.name;
    else if (e.kind === "bash") name = "bash";
    if (!name) continue;
    if (!counts.has(name)) {
      counts.set(name, 0);
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => `${name}:${counts.get(name) ?? 0}`).join(" ");
};

// [Earlier Turns] — one line per turn for every turn except the last summarized
// one (the last is surfaced by Current Status). User intent as a quoted
// one-liner plus a tool-name histogram. This is the "one-line earlier turns"
// tier of graded decay.
const projectEarlierTurns = (events: CompactionEvent[]): string[] => {
  const turns = partitionTurns(events);
  if (turns.length <= 1) return [];
  const lines: string[] = [];
  for (const turn of turns.slice(0, -1)) {
    const userLine = truncate(firstLine(turn.user.text), MAX_EARLIER_USER);
    const tools = histogram(turn.events);
    lines.push(tools ? `"${userLine}" | ${tools}` : `"${userLine}"`);
  }
  return lines;
};

// [Current Status] — a bridge from the summarized window into the kept tail:
// the last summarized user request, the last file-modifying tool call, and the
// last assistant line. Only non-empty fields are emitted.
const projectStatus = (events: CompactionEvent[]): string[] => {
  const lastUser = [...events].reverse().find((e): e is Extract<CompactionEvent, { kind: "user" }> => e.kind === "user");
  const lines: string[] = [];
  if (lastUser) {
    lines.push(`Last request: ${truncate(firstLine(lastUser.text), MAX_STATUS_LINE)}`);
  }
  let lastModify: ToolCallEvent | undefined;
  for (const e of events) {
    if (e.kind === "toolCall" && MODIFYING_TOOLS.has(e.name)) lastModify = e;
  }
  if (lastModify) {
    const path = pathOf(lastModify.args) ?? "";
    lines.push(`Last change: ${lastModify.name}${path ? ` ${path}` : ""}`);
  }
  const lastAssistant = [...events]
    .reverse()
    .find((e): e is Extract<CompactionEvent, { kind: "assistantText" }> => e.kind === "assistantText");
  if (lastAssistant) {
    const text = truncate(firstLine(lastAssistant.text), MAX_STATUS_LINE);
    if (text) lines.push(`Last note: ${text}`);
  }
  return lines;
};

const summarizeArgs = (name: string, args: Record<string, unknown>): string => {
  const primary =
    name === "bash" ? args.command ?? args.cmd ?? args.shell
    : name === "grep" ? args.pattern ?? args.query ?? args.regex
    : name === "find" ? args.pattern
    : pathOf(args);
  if (typeof primary === "string" && primary.trim()) {
    return truncate(firstLine(primary), MAX_TRANSCRIPT_CMD);
  }
  const entries = Object.entries(args).slice(0, 2);
  return entries.map(([key, value]) => `${key}=${truncate(String(value), 40)}`).join(" ");
};

// Brief transcript — the "collapsed transcript" tier of graded decay. A
// rolling window of the last ~120 events rendered as one-liners, each prefixed
// with its stable `(#N)` reference so the agent can point back at a specific
// event without storing its content (principle 0).
const projectTranscript = (events: CompactionEvent[]): string[] => {
  const window = events.slice(-TRANSCRIPT_WINDOW);
  const lines: string[] = [];
  for (const e of window) {
    const ref = `(#${e.index})`;
    if (e.kind === "user") {
      lines.push(`${ref} user: ${truncate(firstLine(e.text), MAX_TRANSCRIPT_LINE)}`);
    } else if (e.kind === "assistantText") {
      lines.push(`${ref} assistant: ${truncate(firstLine(e.text), MAX_TRANSCRIPT_LINE)}`);
    } else if (e.kind === "thinking") {
      const t = truncate(firstLine(e.text), MAX_TRANSCRIPT_THINKING);
      if (t) lines.push(`${ref} thinking: ${t}`);
    } else if (e.kind === "toolCall") {
      lines.push(`${ref} ${e.name}(${summarizeArgs(e.name, e.args)})`);
    } else if (e.kind === "toolResult") {
      const status = e.isError ? "error" : "ok";
      lines.push(`${ref} → ${status}: ${truncate(firstLine(e.text), MAX_TRANSCRIPT_LINE)}`);
    } else if (e.kind === "bash") {
      const status = e.isError ? "error" : "ok";
      lines.push(`${ref} bash(${truncate(firstLine(e.command), MAX_TRANSCRIPT_CMD)}) → ${status}`);
    }
  }
  return lines;
};

export const project = (events: CompactionEvent[]): Sections => ({
  goal: projectGoal(events),
  files: projectFiles(events),
  commits: projectCommits(events),
  outstanding: projectOutstanding(events),
  earlierTurns: projectEarlierTurns(events),
  status: projectStatus(events),
  transcript: projectTranscript(events),
});
