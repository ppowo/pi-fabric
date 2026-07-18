import { omissionLine, sampleAddressed, sampleAddressedFrom } from "./bounds.js";
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
export const MAX_USER_GOAL_LINES = 3;
export const MAX_USER_GOAL_LINE = 1024;
const MAX_USER_ONELINER = 120;
const MAX_EARLIER_USER = 80;
const MAX_STATUS_LINE = 140;
const MAX_TRANSCRIPT_LINE = 100;
const MAX_TRANSCRIPT_THINKING = 80;
const MAX_TRANSCRIPT_CMD = 80;
const MAX_LATER_GOALS = 24;
export const MAX_FILES_PER_KIND = 24;
export const MAX_COMMITS = 20;
const MAX_OUTSTANDING = 32;
export const MAX_UNRESOLVED = 24;
const MAX_RESOLVED = MAX_OUTSTANDING - MAX_UNRESOLVED;
export const MAX_EARLIER_TURNS = 32;
const TRANSCRIPT_WINDOW = 40;

export interface ProjectionOmittedCounts {
  goal: number;
  files: number;
  commits: number;
  outstanding: number;
  earlierTurns: number;
  transcript: number;
}

export interface ProjectionResult {
  sections: Sections;
  omittedCounts: ProjectionOmittedCounts;
}

interface ProjectedSection {
  lines: string[];
  omitted: number;
}

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

// [Session Goal] keeps up to three mechanically normalized, bounded lines
// from the first user message. Later scope changes use bounded one-liners and
// deterministic earliest/latest sampling with source addresses.
const projectGoal = (events: CompactionEvent[]): ProjectedSection => {
  const first = events.find(
    (event): event is Extract<CompactionEvent, { kind: "user" }> => event.kind === "user",
  );
  if (!first) return { lines: [], omitted: 0 };
  const firstLines = first.text.split("\n").filter((line, i, arr) =>
    line.trim() !== "" || (i === 0 && arr.length === 1),
  ).map((line) => truncate(line, MAX_USER_GOAL_LINE));
  const lines: string[] = [...trailingEllipsis(firstLines, MAX_USER_GOAL_LINES)];
  function* laterUsers(): Generator<Extract<CompactionEvent, { kind: "user" }>> {
    let skippedFirst = false;
    for (const event of events) {
      if (event.kind !== "user") continue;
      if (!skippedFirst) {
        skippedFirst = true;
        continue;
      }
      yield event;
    }
  }
  const sampled = sampleAddressedFrom(laterUsers(), MAX_LATER_GOALS);
  for (let index = 0; index < sampled.values.length; index++) {
    if (sampled.omitted > 0 && index === sampled.splitIndex) {
      lines.push(omissionLine(
        sampled.omitted,
        sampled.omittedFirstEntryId,
        sampled.omittedLastEntryId,
        "user scope changes",
      ));
    }
    const user = sampled.values[index]!;
    const line = truncate(firstLine(user.text), MAX_USER_ONELINER);
    if (line) lines.push(`- ${line} [entry ${user.entryId}]`);
  }
  return { lines, omitted: sampled.omitted };
};

// [Files And Changes] — addresses only, never content. A path is recorded when
// its tool call succeeded (isError=false on the paired result). edit ⇒
// Modified, write ⇒ Created, read/grep/find/ls ⇒ Read. A path that was modified
// or created is dropped from Read to avoid redundant weaker entries. Paths are
// trimmed to their common root.
interface FileAddress {
  path: string;
  entryId: string;
}

const projectFiles = (events: CompactionEvent[]): ProjectedSection => {
  const results = new Map<string, boolean>();
  for (const e of events) {
    if (e.kind === "toolResult") results.set(e.toolCallId, e.isError);
  }

  const read = new Map<string, FileAddress>();
  const modified = new Map<string, FileAddress>();
  const created = new Map<string, FileAddress>();

  for (const e of events) {
    if (e.kind !== "toolCall" || !FILE_TOOLS.has(e.name)) continue;
    const path = pathOf(e.args);
    if (!path || results.get(e.toolCallId) !== false) continue;
    const address = { path, entryId: e.entryId };
    if (e.name === "write") {
      if (!created.has(path)) created.set(path, address);
    } else if (e.name === "edit") {
      if (!modified.has(path)) modified.set(path, address);
    } else if (!read.has(path)) {
      read.set(path, address);
    }
  }

  const modifiedSet = new Set<string>();
  for (const path of modified.keys()) modifiedSet.add(path);
  for (const path of created.keys()) modifiedSet.add(path);
  function* filteredRead(): Generator<FileAddress> {
    for (const item of read.values()) {
      if (!modifiedSet.has(item.path)) yield item;
    }
  }
  const sampledCreated = sampleAddressedFrom(created.values(), MAX_FILES_PER_KIND);
  const sampledModified = sampleAddressedFrom(modified.values(), MAX_FILES_PER_KIND);
  const sampledRead = sampleAddressedFrom(filteredRead(), MAX_FILES_PER_KIND);
  const allSampled = [...sampledCreated.values, ...sampledModified.values, ...sampledRead.values];
  if (allSampled.length === 0) return { lines: [], omitted: 0 };
  const root = commonRoot(allSampled.map((item) => item.path));
  const lines: string[] = [];
  let omitted = 0;
  if (root) lines.push(`(under ${root})`);

  const appendKind = (
    header: string,
    sampled: ReturnType<typeof sampleAddressed<FileAddress>>,
  ): void => {
    if (sampled.values.length === 0 && sampled.omitted === 0) return;
    lines.push(header);
    omitted += sampled.omitted;
    for (let index = 0; index < sampled.values.length; index++) {
      if (sampled.omitted > 0 && index === sampled.splitIndex) {
        lines.push(`  ${omissionLine(
          sampled.omitted,
          sampled.omittedFirstEntryId,
          sampled.omittedLastEntryId,
          "file addresses",
        )}`);
      }
      const item = sampled.values[index]!;
      lines.push(`  ${stripRoot(root, item.path)} [entry ${item.entryId}]`);
    }
  };

  appendKind("Created:", sampledCreated);
  appendKind("Modified:", sampledModified);
  appendKind("Read:", sampledRead);
  return { lines, omitted };
};

// [Commits] — bash tool calls whose command begins with `git commit`, paired
// with the first line of their output (the commit summary the shell prints).
const projectCommits = (events: CompactionEvent[]): ProjectedSection => {
  const commits: { entryId: string; line: string }[] = [];
  for (const e of events) {
    if (e.kind !== "bash" || !e.command.trimStart().startsWith("git commit")) continue;
    const summary = firstLine(e.output).trim();
    const line = summary || truncate(firstLine(e.command), MAX_LINE);
    if (line) commits.push({ entryId: e.entryId, line });
  }
  const sampled = sampleAddressed(commits, MAX_COMMITS);
  const lines: string[] = [];
  for (let index = 0; index < sampled.values.length; index++) {
    if (sampled.omitted > 0 && index === sampled.splitIndex) {
      lines.push(omissionLine(
        sampled.omitted,
        sampled.omittedFirstEntryId,
        sampled.omittedLastEntryId,
        "commits",
      ));
    }
    const commit = sampled.values[index]!;
    lines.push(`- ${commit.line} [entry ${commit.entryId}]`);
  }
  return { lines, omitted: sampled.omitted };
};

type SourceTag = "ERROR" | "WARN" | "INFO";

interface ErrorItem {
  index: number;
  entryId: string;
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
// addressed. Open and resolved collections are independently sampled; omitted
// records retain count and entry-id range addresses.
const projectOutstandingWithMetadata = (events: CompactionEvent[]): ProjectedSection => {
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
      items.push({ index: e.index, entryId: e.entryId, tag, description: detail, resolved });
    }
    if (e.kind === "bash" && e.isError) {
      const isUserBash = e.toolCallId === "";
      const tag = tagFor("bash", isUserBash);
      const detail = `bash: ${truncate(firstLine(e.command), MAX_LINE)}`;
      const resolved = e.command.trim()
        ? successBash.some((s) => s.command === e.command && s.index > e.index)
        : false;
      items.push({ index: e.index, entryId: e.entryId, tag, description: detail, resolved });
    }
  }

  if (items.length === 0) return { lines: [], omitted: 0 };
  const unresolved = items.filter((i) => !i.resolved).sort((a, b) => a.index - b.index);
  const resolved = items.filter((i) => i.resolved).sort((a, b) => a.index - b.index);
  const sampledUnresolved = sampleAddressed(unresolved, MAX_UNRESOLVED);
  const sampledResolved = sampleAddressed(resolved, MAX_RESOLVED);
  const lines: string[] = [];
  const append = (sampled: ReturnType<typeof sampleAddressed<ErrorItem>>, noun: string): void => {
    for (let index = 0; index < sampled.values.length; index++) {
      if (sampled.omitted > 0 && index === sampled.splitIndex) {
        lines.push(omissionLine(
          sampled.omitted,
          sampled.omittedFirstEntryId,
          sampled.omittedLastEntryId,
          noun,
        ));
      }
      const item = sampled.values[index]!;
      lines.push(`- [${item.tag}] ${item.description}${item.resolved ? " [RESOLVED]" : ""} [entry ${item.entryId}]`);
    }
  };
  append(sampledUnresolved, "open error records");
  append(sampledResolved, "resolved error records");
  return { lines, omitted: sampledUnresolved.omitted + sampledResolved.omitted };
};

export const projectOutstanding = (events: CompactionEvent[]): string[] =>
  projectOutstandingWithMetadata(events).lines;

interface EarlierTurnAddress {
  entryId: string;
  userLine: string;
  tools: string;
}

// [Earlier Turns] — sampled one-liners for turns before the latest summarized
// one (which Current Status surfaces), plus tool-name histograms and an
// entry-range address for any omitted middle turns.
const projectEarlierTurns = (events: CompactionEvent[]): ProjectedSection => {
  function* earlierTurns(): Generator<EarlierTurnAddress> {
    let currentUser: Extract<CompactionEvent, { kind: "user" }> | undefined;
    let counts = new Map<string, number>();
    let order: string[] = [];
    const completed = (): EarlierTurnAddress | undefined => {
      if (!currentUser) return undefined;
      return {
        entryId: currentUser.entryId,
        userLine: truncate(firstLine(currentUser.text), MAX_EARLIER_USER),
        tools: order.map((name) => `${name}:${counts.get(name) ?? 0}`).join(" "),
      };
    };
    for (const event of events) {
      if (event.kind === "user") {
        const turn = completed();
        if (turn) yield turn;
        currentUser = event;
        counts = new Map<string, number>();
        order = [];
        continue;
      }
      if (!currentUser) continue;
      const name = event.kind === "toolCall" ? event.name : event.kind === "bash" ? "bash" : undefined;
      if (!name) continue;
      if (!counts.has(name)) order.push(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const sampled = sampleAddressedFrom(earlierTurns(), MAX_EARLIER_TURNS);
  const lines: string[] = [];
  for (let index = 0; index < sampled.values.length; index++) {
    if (sampled.omitted > 0 && index === sampled.splitIndex) {
      lines.push(omissionLine(
        sampled.omitted,
        sampled.omittedFirstEntryId,
        sampled.omittedLastEntryId,
        "earlier turns",
      ));
    }
    const turn = sampled.values[index]!;
    lines.push(`${turn.tools ? `"${turn.userLine}" | ${turn.tools}` : `"${turn.userLine}"`} [entry ${turn.entryId}]`);
  }
  return { lines, omitted: sampled.omitted };
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
// rolling window of the last 40 events rendered as one-liners, each prefixed
// with its stable `(#N)` reference so the agent can point back at a specific
// event without storing its content (principle 0).
const projectTranscript = (events: CompactionEvent[]): ProjectedSection => {
  const window = events.slice(-TRANSCRIPT_WINDOW);
  const lines: string[] = [];
  const omitted = events.length - window.length;
  if (omitted > 0) {
    lines.push(omissionLine(
      omitted,
      events[0]?.entryId,
      events[omitted - 1]?.entryId,
      "transcript events",
    ));
  }
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
  return { lines, omitted };
};

export const projectWithMetadata = (events: CompactionEvent[]): ProjectionResult => {
  const goal = projectGoal(events);
  const files = projectFiles(events);
  const commits = projectCommits(events);
  const outstanding = projectOutstandingWithMetadata(events);
  const earlierTurns = projectEarlierTurns(events);
  const transcript = projectTranscript(events);
  return {
    sections: {
      goal: goal.lines,
      files: files.lines,
      commits: commits.lines,
      outstanding: outstanding.lines,
      earlierTurns: earlierTurns.lines,
      status: projectStatus(events),
      transcript: transcript.lines,
    },
    omittedCounts: {
      goal: goal.omitted,
      files: files.omitted,
      commits: commits.omitted,
      outstanding: outstanding.omitted,
      earlierTurns: earlierTurns.omitted,
      transcript: transcript.omitted,
    },
  };
};

export const project = (events: CompactionEvent[]): Sections =>
  projectWithMetadata(events).sections;
