import { firstLine, type CompactionEvent, type ToolCallEvent } from "./normalize.js";

type ProbeClass = "content" | "address";

export interface Probe {
  id: string;
  class: ProbeClass;
  question: string;
  answer: string;
}

interface ProbeFailure {
  probe: Probe;
  reason: string;
}

export interface ProbeCheck {
  passed: Probe[];
  failed: ProbeFailure[];
}

export interface QaReport {
  score: number;
  contentScore: number;
  addressScore: number;
  failures: ProbeFailure[];
}

const MAX_USER_GOAL_LINES = 3;
const MAX_EARLIER_USER = 80;
const MAX_ERROR_SIGNATURE = 140;
const TRANSCRIPT_WINDOW = 120;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const MODIFYING_TOOLS = new Set(["edit", "write"]);

const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const pathOf = (args: Record<string, unknown>): string | undefined => {
  const value = args.path ?? args.file ?? args.dir;
  return typeof value === "string" && value.trim() ? value : undefined;
};

const essentialPathToken = (path: string): string => {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  const trimmed = path.slice(0, end);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1) || path;
};

const goalAnswer = (text: string): string => {
  const lines = text.split("\n").filter((line, index, all) =>
    line.trim() !== "" || (index === 0 && all.length === 1),
  );
  if (lines.length <= MAX_USER_GOAL_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_USER_GOAL_LINES), "…"].join("\n");
};

const commitHashOf = (output: string): string | undefined => {
  const line = firstLine(output).trim();
  if (!line.startsWith("[")) return undefined;
  const close = line.indexOf("]");
  if (close < 0) return undefined;
  const fields = line.slice(1, close).trim().split(/\s+/);
  return fields.at(-1) || undefined;
};

const eventWindow = (events: CompactionEvent[], cutIndex: number): CompactionEvent[] => {
  if (!Number.isFinite(cutIndex)) return [];
  const end = Math.max(0, Math.min(events.length, Math.trunc(cutIndex)));
  return events.slice(0, end);
};

const unresolvedErrors = (events: CompactionEvent[]): (Extract<CompactionEvent, { kind: "toolResult" }> | Extract<CompactionEvent, { kind: "bash" }>)[] => {
  const callById = new Map<string, ToolCallEvent>();
  const resultError = new Map<string, boolean>();
  for (const event of events) {
    if (event.kind === "toolCall") callById.set(event.toolCallId, event);
    if (event.kind === "toolResult") resultError.set(event.toolCallId, event.isError);
  }

  const successfulPaths: { index: number; path: string }[] = [];
  for (const event of events) {
    if (event.kind !== "toolCall" || !FILE_TOOLS.has(event.name)) continue;
    if (resultError.get(event.toolCallId) !== false) continue;
    const path = pathOf(event.args);
    if (path) successfulPaths.push({ index: event.index, path });
  }

  const successfulBash = events.filter(
    (event): event is Extract<CompactionEvent, { kind: "bash" }> =>
      event.kind === "bash" && !event.isError && event.command.trim() !== "",
  );

  const unresolved: (Extract<CompactionEvent, { kind: "toolResult" }> | Extract<CompactionEvent, { kind: "bash" }>)[] = [];
  for (const event of events) {
    if (event.kind === "toolResult" && event.isError) {
      const call = event.toolCallId ? callById.get(event.toolCallId) : undefined;
      const path = call ? pathOf(call.args) : undefined;
      const resolved = path !== undefined && successfulPaths.some(
        (success) => success.path === path && success.index > event.index,
      );
      if (!resolved) unresolved.push(event);
    } else if (event.kind === "bash" && event.isError) {
      const resolved = event.command.trim() !== "" && successfulBash.some(
        (success) => success.command === event.command && success.index > event.index,
      );
      if (!resolved) unresolved.push(event);
    }
  }
  return unresolved;
};

const score = (probes: Probe[], failures: ProbeFailure[]): number =>
  probes.length === 0 ? 1 : (probes.length - failures.length) / probes.length;

// Generate reconstruction questions from ground-truth events only. cutIndex is
// the exclusive array boundary (and therefore matches the 1-based index of the
// final included normalized event). No projection or rendered section is read.
export const generateProbes = (events: CompactionEvent[], cutIndex: number): Probe[] => {
  const source = eventWindow(events, cutIndex);
  const probes: Probe[] = [];
  const users = source.filter(
    (event): event is Extract<CompactionEvent, { kind: "user" }> => event.kind === "user",
  );

  const firstUser = users[0];
  if (firstUser) {
    probes.push({
      id: "goal",
      class: "content",
      question: "What goal did the first user message establish?",
      answer: goalAnswer(firstUser.text),
    });
  }

  const resultError = new Map<string, boolean>();
  for (const event of source) {
    if (event.kind === "toolResult") resultError.set(event.toolCallId, event.isError);
  }
  const seenPaths = new Set<string>();
  for (const event of source) {
    if (event.kind !== "toolCall" || !MODIFYING_TOOLS.has(event.name)) continue;
    const path = pathOf(event.args);
    if (!path || resultError.get(event.toolCallId) !== false || seenPaths.has(path)) continue;
    seenPaths.add(path);
    probes.push({
      id: `modified-file:${event.index}:${path}`,
      class: "content",
      question: `Which file-modification address must remain available for ${path}?`,
      answer: essentialPathToken(path),
    });
  }

  const calls = new Map<string, ToolCallEvent>();
  for (const event of source) {
    if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  }
  for (const event of unresolvedErrors(source)) {
    if (event.kind === "toolResult") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      const path = call ? pathOf(call.args) : undefined;
      const signature = truncate(firstLine(event.text), MAX_ERROR_SIGNATURE);
      probes.push({
        id: `unresolved-error:${event.index}`,
        class: "content",
        question: `What is the signature of unresolved ${event.toolName || "tool"} error #${event.index}?`,
        answer: path
          ? `${event.toolName} ${path}: ${signature}`
          : `${event.toolName}: ${signature}`,
      });
    } else {
      probes.push({
        id: `unresolved-error:${event.index}`,
        class: "content",
        question: `What command identifies unresolved bash error #${event.index}?`,
        answer: `bash: ${truncate(firstLine(event.command), MAX_ERROR_SIGNATURE)}`,
      });
    }
  }

  for (const event of source) {
    if (event.kind !== "bash" || event.isError || !event.command.trimStart().startsWith("git commit")) continue;
    const hash = commitHashOf(event.output);
    if (!hash) continue;
    probes.push({
      id: `commit:${event.index}`,
      class: "content",
      question: `Which commit hash was produced by commit event #${event.index}?`,
      answer: hash,
    });
  }

  let lastModify: ToolCallEvent | undefined;
  for (const event of source) {
    if (event.kind === "toolCall" && MODIFYING_TOOLS.has(event.name) && pathOf(event.args)) {
      lastModify = event;
    }
  }
  if (lastModify) {
    const path = pathOf(lastModify.args)!;
    probes.push({
      id: `last-modification:${lastModify.index}`,
      class: "content",
      question: "What path was targeted by the last file-modifying tool call?",
      answer: path,
    });
  }

  const earlierUsers = users.slice(0, -1);
  for (let index = 0; index < earlierUsers.length; index++) {
    const user = earlierUsers[index]!;
    probes.push({
      id: `earlier-turn-count:${user.index}`,
      class: "content",
      question: `Which one-liner accounts for earlier turn ${index + 1} of ${earlierUsers.length}?`,
      answer: `"${truncate(firstLine(user.text), MAX_EARLIER_USER)}"`,
    });
  }

  const transcriptStart = source.slice(-TRANSCRIPT_WINDOW)[0]?.index ?? Number.POSITIVE_INFINITY;
  for (const user of earlierUsers) {
    if (user.index >= transcriptStart) continue;
    probes.push({
      id: `earlier-turn-address:${user.index}`,
      class: "address",
      question: `What summary pointer keeps earlier turn #${user.index} addressable outside the brief transcript?`,
      answer: `"${truncate(firstLine(user.text), MAX_EARLIER_USER)}"`,
    });
  }

  probes.push({
    id: "footer-recall",
    class: "address",
    question: "What footer pointer enables expansion from the append-only session log?",
    answer: "memory.recall / vcc_recall-style",
  });

  return probes;
};

export const checkProbes = (summaryText: string, probes: Probe[]): ProbeCheck => {
  const passed: Probe[] = [];
  const failed: ProbeFailure[] = [];
  for (const probe of probes) {
    if (summaryText.includes(probe.answer)) {
      passed.push(probe);
    } else {
      failed.push({
        probe,
        reason: `summary does not contain expected answer ${JSON.stringify(probe.answer)}`,
      });
    }
  }
  return { passed, failed };
};

export const qaReport = (events: CompactionEvent[], cutIndex: number, summaryText: string): QaReport => {
  const probes = generateProbes(events, cutIndex);
  const { failed } = checkProbes(summaryText, probes);
  const content = probes.filter((probe) => probe.class === "content");
  const address = probes.filter((probe) => probe.class === "address");
  const contentFailures = failed.filter(({ probe }) => probe.class === "content");
  const addressFailures = failed.filter(({ probe }) => probe.class === "address");
  return {
    score: score(probes, failed),
    contentScore: score(content, contentFailures),
    addressScore: score(address, addressFailures),
    failures: failed,
  };
};
