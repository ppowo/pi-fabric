import type {
  CompactionResult,
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { normalizeEntries } from "./normalize.js";
import { project, type Sections } from "./projections.js";
import { renderSummary } from "./render.js";

// The cut is recomputed from the raw branch entries (principle 1) — never from
// the previous summary and never from pi-core's prepared slice, which may
// already reflect a split turn. We cut at a complete-turn boundary: the last
// user message, pushed back to the previous user message when the following
// turn is still in flight (unmatched tool calls). This guarantees the cut
// never orphans a tool_result from its tool_call (the summarized part always
// ends at a complete turn). When no earlier boundary exists we fall back to
// the compact-all sentinel (firstKeptEntryId = ""), which pi-core treats as
// "keep nothing from before"; the deterministic summary then stands in for
// the whole window.

type CompactionEngine = "pi" | "fabric";

interface MessageEntry {
  entry: SessionEntry;
  message: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
  };
}

const isMessageEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> =>
  entry.type === "message";

const isHiddenEmptyCustom = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; display?: unknown; content?: unknown };
  if (candidate.role !== "custom" || candidate.display !== false) return false;
  const content = candidate.content;
  return content === "" || (Array.isArray(content) && content.length === 0);
};

const toolCallIdsOf = (message: { content?: unknown }): string[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part && (part as { type: string }).type === "toolCall") {
      const id = (part as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
};

const findLastCompaction = (entries: SessionEntry[]): { index: number; firstKeptEntryId: string } | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "compaction") {
      return { index: i, firstKeptEntryId: entry.firstKeptEntryId };
    }
  }
  return undefined;
};

// Collect the live message entries — the raw window this compaction works on —
// starting from the last compaction's kept boundary (or right after the last
// compaction entry when the kept id is missing or the compact-all sentinel).
const collectLive = (entries: SessionEntry[]): MessageEntry[] => {
  const last = findLastCompaction(entries);
  const live: MessageEntry[] = [];
  if (!last) {
    for (const entry of entries) {
      if (!isMessageEntry(entry)) continue;
      if (isHiddenEmptyCustom(entry.message)) continue;
      live.push({ entry, message: entry.message as MessageEntry["message"] });
    }
    return live;
  }
  const keptId = last.firstKeptEntryId;
  const orphan = !keptId || !entries.some((e) => e.id === keptId);
  if (orphan) {
    for (let i = last.index + 1; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!isMessageEntry(entry)) continue;
      if (isHiddenEmptyCustom(entry.message)) continue;
      live.push({ entry, message: entry.message as MessageEntry["message"] });
    }
    return live;
  }
  let foundKept = false;
  for (const entry of entries) {
    if (!foundKept && entry.id === keptId) foundKept = true;
    if (!foundKept) continue;
    if (!isMessageEntry(entry)) continue;
    if (isHiddenEmptyCustom(entry.message)) continue;
    live.push({ entry, message: entry.message as MessageEntry["message"] });
  }
  return live;
};

const lastUserIndex = (live: MessageEntry[]): number => {
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i]!.message.role === "user") return i;
  }
  return -1;
};

// True when the turn starting at `cutIdx` has tool calls without matching
// results in the live window (assistant emitted a call but no result landed
// before compaction). Structural: id match only.
const turnIncomplete = (live: MessageEntry[], cutIdx: number): boolean => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (let i = cutIdx + 1; i < live.length; i++) {
    const message = live[i]!.message;
    if (message.role === "user") break;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.add(message.toolCallId);
      continue;
    }
    for (const id of toolCallIdsOf(message)) {
      calls.add(id);
      if (!results.has(id)) {
        // unmatched so far; keep scanning in case a later result matches
      }
    }
  }
  for (const id of calls) {
    if (!results.has(id)) return true;
  }
  return false;
};

const previousUserIndex = (live: MessageEntry[], before: number): number => {
  for (let i = before - 1; i >= 0; i--) {
    if (live[i]!.message.role === "user") return i;
  }
  return -1;
};

export type CutResult =
  | {
      ok: true;
      summarized: SessionEntry[];
      firstKeptEntryId: string;
      firstSummarizedEntryId: string;
      lastSummarizedEntryId: string;
      lastTimestamp: string;
    }
  | { ok: false; reason: "empty" };

// Pure cut over the raw branch entries. Exported for deterministic testing.
export const computeCut = (branchEntries: SessionEntry[]): CutResult => {
  const live = collectLive(branchEntries);
  if (live.length === 0) return { ok: false, reason: "empty" };

  let cutIdx = lastUserIndex(live);
  if (cutIdx > 0 && turnIncomplete(live, cutIdx)) {
    const prev = previousUserIndex(live, cutIdx);
    cutIdx = prev; // may be -1 / 0
  }

  if (cutIdx <= 0) {
    // No earlier complete-turn boundary to cut at — compact the whole window.
    const summarized = live.map((l) => l.entry);
    return boundary(summarized, "");
  }

  const summarized = live.slice(0, cutIdx).map((l) => l.entry);
  const firstKeptEntryId = live[cutIdx]!.entry.id;
  return boundary(summarized, firstKeptEntryId);
};

const boundary = (
  summarized: SessionEntry[],
  firstKeptEntryId: string,
): CutResult => {
  if (summarized.length === 0) return { ok: false, reason: "empty" };
  const first = summarized[0]!;
  const last = summarized[summarized.length - 1]!;
  return {
    ok: true,
    summarized,
    firstKeptEntryId,
    firstSummarizedEntryId: first.id,
    lastSummarizedEntryId: last.id,
    lastTimestamp: last.timestamp,
  };
};

export interface FabricCompactionDetails {
  compactor: "fabric";
  version: 1;
  sections: string[];
  summarizedEntryRange: { first: string; last: string };
  sourceEntryCount: number;
  firstKeptEntryId: string;
  timestamp: string;
}

export const compileFabricSummary = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  enrichers: readonly CompactionEnricher[] = NO_BUILTIN_ENRICHERS,
): { compaction: CompactionResult<FabricCompactionDetails> } | { cancel: true; reason: string } => {
  const cut = computeCut(branchEntries);
  if (!cut.ok) return { cancel: true, reason: "fabric: nothing to compact" };

  const events = normalizeEntries(cut.summarized);
  const sections: Sections = project(events);
  runEnrichers(enrichers, events, sections);

  const summary = renderSummary(sections, {
    firstEntryId: cut.firstSummarizedEntryId,
    lastEntryId: cut.lastSummarizedEntryId,
    lastTimestamp: cut.lastTimestamp,
  });

  const details: FabricCompactionDetails = {
    compactor: "fabric",
    version: 1,
    sections: SECTION_HEADERS.filter(({ key }) => sections[key].length > 0).map(({ header }) => header),
    summarizedEntryRange: { first: cut.firstSummarizedEntryId, last: cut.lastSummarizedEntryId },
    sourceEntryCount: events.length,
    firstKeptEntryId: cut.firstKeptEntryId,
    timestamp: cut.lastTimestamp,
  };

  return {
    compaction: {
      summary,
      firstKeptEntryId: cut.firstKeptEntryId,
      tokensBefore,
      details,
    },
  };
};

const SECTION_HEADERS: { key: keyof Sections; header: string }[] = [
  { key: "goal", header: "[Session Goal]" },
  { key: "files", header: "[Files And Changes]" },
  { key: "commits", header: "[Commits]" },
  { key: "outstanding", header: "[Outstanding Context]" },
  { key: "earlierTurns", header: "[Earlier Turns]" },
  { key: "status", header: "[Current Status]" },
];

export interface CompactionHookOptions {
  getEngine: () => CompactionEngine;
  enrichers?: readonly CompactionEnricher[];
}

export const registerCompactionHook = (pi: ExtensionAPI, options: CompactionHookOptions): void => {
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
    if (options.getEngine() !== "fabric") return; // ship dark: default "pi" passthrough
    const { preparation, branchEntries } = event;
    if (!branchEntries || branchEntries.length === 0) return;
    const result = compileFabricSummary(
      branchEntries,
      preparation.tokensBefore,
      options.enrichers,
    );
    if ("cancel" in result) return { cancel: true };
    return { compaction: result.compaction };
  });
};
