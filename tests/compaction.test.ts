import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { normalizeFabricConfig, DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import {
  computeCut,
  compileFabricSummary,
  registerCompactionHook,
} from "../src/compaction/hook.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project, projectOutstanding } from "../src/compaction/projections.js";
import type {
  CompactionEntry,
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

// Fixture builders. Ids are deterministic so the golden-determinism test can
// build a fixture once and recompile it for byte-identical comparison.
let idCounter = 0;
const resetIds = (): void => {
  idCounter = 0;
};
const nextId = (): string => `e${++idCounter}`;
const iso = (n: number): string => `2024-01-0${1 + Math.floor(n / 86400)}T00:00:${String(n % 60).padStart(2, "0")}Z`;
let clock = 0;
const resetClock = (): void => {
  clock = 0;
};
const tick = (): number => ++clock;

const user = (text: string): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: { role: "user", content: text, timestamp: tick() },
});

const textPart = (text: string): { type: "text"; text: string } => ({ type: "text", text });
const toolCallPart = (id: string, name: string, args: Record<string, unknown>): {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} => ({ type: "toolCall", id, name, arguments: args });

const assistant = (...parts: ({ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[]): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "assistant",
    content: parts,
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: tick(),
  },
});

const toolResult = (toolCallId: string, toolName: string, text: string, isError = false): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [textPart(text)],
    isError,
    timestamp: tick(),
  },
});

const bashExec = (command: string, exitCode: number | undefined, output: string): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "bashExecution",
    command,
    output,
    exitCode,
    cancelled: false,
    truncated: false,
    timestamp: tick(),
  } as SessionMessageEntry["message"],
});

const compactionEntry = (firstKeptEntryId: string): CompactionEntry => ({
  type: "compaction",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  summary: "(prior)",
  firstKeptEntryId,
  tokensBefore: 1000,
});

const callId = (n: number): string => `call_${n}`;
let callCounter = 0;
const resetCallIds = (): void => {
  callCounter = 0;
};
const nextCallId = (): string => callId(++callCounter);

const buildSession = (...entries: SessionEntry[]): SessionEntry[] => entries;

describe("compaction config", () => {
  it("defaults to the fabric engine", () => {
    expect(DEFAULT_FABRIC_CONFIG.compaction.engine).toBe("fabric");
  });

  it("normalizes a pi engine escape hatch and rejects unknown values", () => {
    expect(normalizeFabricConfig({ compaction: { engine: "pi" } }).compaction.engine).toBe("pi");
    expect(normalizeFabricConfig({ compaction: { engine: "bogus" } }).compaction.engine).toBe("fabric");
    expect(normalizeFabricConfig({}).compaction.engine).toBe("fabric");
  });
});

type InteropCompactionEvent = SessionBeforeCompactEvent & {
  _fabricCompaction?: boolean;
  _piVccOverriding?: boolean;
};

const compactionHandler = (
  engine: "pi" | "fabric",
): ((event: SessionBeforeCompactEvent) => unknown) => {
  let handler: ((event: SessionBeforeCompactEvent) => unknown) | undefined;
  const pi = {
    on(name: string, candidate: unknown) {
      if (name === "session_before_compact") {
        handler = candidate as (event: SessionBeforeCompactEvent) => unknown;
      }
    },
  } as unknown as ExtensionAPI;
  registerCompactionHook(pi, { getEngine: () => engine });
  if (!handler) throw new Error("compaction hook was not registered");
  return handler;
};

const compactionEvent = (
  branchEntries: SessionEntry[],
  customInstructions?: string,
): InteropCompactionEvent => ({
  preparation: { tokensBefore: 1000 },
  branchEntries,
  ...(customInstructions === undefined ? {} : { customInstructions }),
}) as unknown as InteropCompactionEvent;

describe("compaction pi-vcc interop", () => {
  it("defers to an explicit /pi-vcc sentinel", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("compact this"), assistant(textPart("done"))),
      "__pi_vcc__",
    );

    expect(compactionHandler("fabric")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("marks the mutable event when fabric claims compaction", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("compact this"), assistant(textPart("done"))),
    );

    expect(compactionHandler("fabric")(event)).toHaveProperty("compaction");
    expect(event._fabricCompaction).toBe(true);
  });

  it("does not cancel a pi-vcc summary when there is nothing to compact", () => {
    const event = compactionEvent([]);
    event._piVccOverriding = true;

    expect(compactionHandler("fabric")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("cancels empty compaction when pi-vcc has not produced a summary", () => {
    const event = compactionEvent([]);

    expect(compactionHandler("fabric")(event)).toEqual({ cancel: true });
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("leaves the pi engine passthrough unchanged", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("use pi core"), assistant(textPart("done"))),
    );

    expect(compactionHandler("pi")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });
});

describe("compaction golden determinism", () => {
  it("produces byte-identical output across repeated compiles of the same fixture", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const c3 = nextCallId();
    const session = buildSession(
      user("Build the deterministic compaction engine.\nKeep it minimal.\nNo regex."),
      assistant(toolCallPart(c1, "read", { path: "src/a.ts" })),
      toolResult(c1, "read", "contents of a"),
      assistant(textPart("I will edit b and create c"), toolCallPart(c2, "edit", { path: "src/b.ts" })),
      toolResult(c2, "edit", "edited b.ts"),
      assistant(toolCallPart(c3, "write", { path: "src/c.ts" })),
      toolResult(c3, "write", "wrote c.ts"),
      user("now add tests"),
    );
    const first = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    const second = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(second.compaction.summary).toBe(first.compaction.summary);
    expect(first.compaction.summary).toContain("[Session Goal]");
    expect(first.compaction.summary).toContain("[Files And Changes]");
    expect(first.compaction.summary).toContain("(under src/)");
    expect(first.compaction.summary).toContain("Created:");
    expect(first.compaction.summary).toContain("Modified:");
    // No dynamic "now" timestamp: the footer marker is the last entry's timestamp.
    expect(first.compaction.summary).toContain("[compacted 2024-01-0");
    expect(first.compaction.summary).toContain("memory.recall / vcc_recall-style");
  });

  it("emits only non-empty sections in fixed order", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const session = buildSession(user("single turn, no tools"), assistant(textPart("acknowledged")));
    // Only one user turn → cut falls back to compact-all; summary has goal +
    // status + transcript but no files/commits/outstanding/earlier-turns.
    const { compaction } = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(compaction.summary).not.toContain("[Files And Changes]");
    expect(compaction.summary).not.toContain("[Commits]");
    expect(compaction.summary).not.toContain("[Outstanding Context]");
    expect(compaction.summary).not.toContain("[Earlier Turns]");
    const goalIdx = compaction.summary.indexOf("[Session Goal]");
    const statusIdx = compaction.summary.indexOf("[Current Status]");
    const transIdx = compaction.summary.indexOf("---");
    expect(goalIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(transIdx);
  });
});

describe("compaction double-compaction stability", () => {
  it("recomputes the second summary from the live window only — no drift from the first summary", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const session1 = buildSession(
      user("First goal: scaffold the module"),
      assistant(textPart("scaffolding"), toolCallPart(c1, "read", { path: "src/a.ts" })),
      toolResult(c1, "read", "a contents"),
      user("Second goal: wire it up"),
    );
    const first = compileFabricSummary(session1, 1000) as {
      compaction: { firstKeptEntryId: string; summary: string };
    };
    expect(first.compaction.firstKeptEntryId).not.toBe("");
    const keptId = first.compaction.firstKeptEntryId;

    // Simulate the post-compaction branch: prior entries + compaction marker +
    // a fresh batch of work that should drive the next summary.
    const c2 = nextCallId();
    const session2: SessionEntry[] = [
      ...session1,
      compactionEntry(keptId),
      assistant(textPart("wiring"), toolCallPart(c2, "write", { path: "src/b.ts" })),
      toolResult(c2, "write", "wrote b.ts"),
      user("Third goal: ship it"),
      assistant(textPart("done")),
      user("Fourth goal: review"),
    ];
    const second = compileFabricSummary(session2, 2000) as {
      compaction: { summary: string; firstKeptEntryId: string };
    };

    // The second summary is computed from the live window (kept turn + new
    // batch). It must NOT carry the first goal, which lived only in the
    // pre-compaction entries — proving the summary is a function of the raw
    // live window, never of the previous summary.
    expect(second.compaction.summary).not.toContain("First goal");
    expect(second.compaction.summary).toContain("Second goal");
    expect(second.compaction.summary).toContain("Third goal");
    expect(second.compaction.summary).not.toContain("Fourth goal");
    // Files come from the second window only.
    expect(second.compaction.summary).toContain("src/b.ts");
    expect(second.compaction.summary).not.toContain("src/a.ts");
    expect(second.compaction.firstKeptEntryId).not.toBe(keptId);
  });
});

describe("compaction error state machine", () => {
  it("marks a file error [RESOLVED] when the same path is later edited successfully", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const session = buildSession(
      user("fix the bug"),
      assistant(toolCallPart(c1, "read", { path: "src/x.ts" })),
      toolResult(c1, "read", "Error: file not found", true),
      assistant(textPart("retrying"), toolCallPart(c2, "edit", { path: "src/x.ts" })),
      toolResult(c2, "edit", "edited"),
      user("thanks"),
    );
    const events = normalizeEntries(session.slice(0, 5));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("read src/x.ts") && l.includes("[WARN]") && l.includes("[RESOLVED]"))).toBe(true);
  });

  it("marks a bash error [RESOLVED] when the same command is later re-run OK", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const session = buildSession(
      user("run the build"),
      assistant(toolCallPart(c1, "bash", { command: "make test" })),
      toolResult(c1, "bash", "make: *** failed", true),
      assistant(toolCallPart(c2, "bash", { command: "make test" })),
      toolResult(c2, "bash", "all tests passed"),
      user("done"),
    );
    const events = normalizeEntries(session.slice(0, 5));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("bash: make test") && l.includes("[ERROR]") && l.includes("[RESOLVED]"))).toBe(true);
  });

  it("leaves an error open ([ERROR], no [RESOLVED]) when nothing resolves it", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const session = buildSession(
      user("do work"),
      assistant(toolCallPart(c1, "edit", { path: "src/y.ts" })),
      toolResult(c1, "edit", "Error: permission denied", true),
      user("next"),
    );
    const events = normalizeEntries(session.slice(0, 3));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("edit src/y.ts") && l.includes("[ERROR]") && !l.includes("[RESOLVED]"))).toBe(true);
  });
});

describe("compaction cut never orphans a tool_result from its tool_call", () => {
  const assertNoOrphan = (branchEntries: SessionEntry[]): void => {
    const cut = computeCut(branchEntries);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const summarizedIds = new Set(cut.summarized.map((e) => e.id));
    // toolCallId → result entry id, across the whole branch.
    const callToResultEntry = new Map<string, string>();
    for (const e of branchEntries) {
      if (e.type !== "message") continue;
      const msg = e.message as { role?: string; toolCallId?: string };
      if (msg.role === "toolResult" && msg.toolCallId) callToResultEntry.set(msg.toolCallId, e.id);
    }
    // For every toolCall in the summarized part, its result (if it exists in
    // the branch) must also be in the summarized part — never in the kept tail.
    for (const e of cut.summarized) {
      if (e.type !== "message") continue;
      const content = (e.message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
          const id = (part as { id?: string }).id;
          if (!id) continue;
          const resultEntryId = callToResultEntry.get(id);
          if (resultEntryId && !summarizedIds.has(resultEntryId)) {
            throw new Error(`orphan: toolCall ${id} summarized but its result is in the kept tail`);
          }
        }
      }
    }
  };

  it("normal multi-turn cut keeps complete turns together", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    assertNoOrphan(
      buildSession(
        user("turn one"),
        assistant(toolCallPart(c1, "read", { path: "a.ts" })),
        toolResult(c1, "read", "a"),
        user("turn two"),
        assistant(toolCallPart(c2, "edit", { path: "a.ts" })),
        toolResult(c2, "edit", "edited"),
        user("turn three"),
      ),
    );
  });

  it("pushes the cut back when the last turn is in flight (unmatched tool call)", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const c3 = nextCallId();
    const session = buildSession(
      user("turn one"),
      assistant(toolCallPart(c1, "read", { path: "a.ts" })),
      toolResult(c1, "read", "a"),
      user("turn two"),
      assistant(textPart("working"), toolCallPart(c2, "edit", { path: "b.ts" })),
      toolResult(c2, "edit", "edited b"),
      user("turn three"),
      assistant(toolCallPart(c3, "bash", { command: "make" })), // no result yet — in flight
    );
    assertNoOrphan(session);
    const cut = computeCut(session);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // The in-flight bash call (call_3) must be KEPT, not summarized.
    const summarizedHasCall3 = cut.summarized.some((e) => {
      if (e.type !== "message") return false;
      const content = (e.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return false;
      return content.some((p) => p && typeof p === "object" && (p as { id?: string }).id === c3);
    });
    expect(summarizedHasCall3).toBe(false);
  });
});

describe("compaction empty and tiny history edge cases", () => {
  it("cancels on empty history", () => {
    resetIds();
    expect(computeCut(buildSession()).ok).toBe(false);
    const result = compileFabricSummary([], 1000);
    expect("cancel" in result).toBe(true);
  });

  it("cancels when only a compaction marker remains with no live messages", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const result = computeCut(buildSession(compactionEntry("nonexistent")));
    expect(result.ok).toBe(false);
  });

  it("falls back to compact-all for a single user turn", () => {
    resetIds();
    resetClock();
    const session = buildSession(user("just one prompt"), assistant(textPart("reply")));
    const cut = computeCut(session);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.firstKeptEntryId).toBe("");
    expect(cut.summarized.length).toBe(2);
  });

  it("still renders a stable summary for a tiny session", () => {
    resetIds();
    resetClock();
    const session = buildSession(user("hi"), assistant(textPart("hello")));
    const a = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    const b = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(b.compaction.summary).toBe(a.compaction.summary);
    expect(a.compaction.summary).toContain("[Session Goal]");
  });
});

describe("compaction benchmark", () => {
  it("compacts a synthetic 2000-entry session in under 200ms", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const entries: SessionEntry[] = [];
    entries.push(user("Initial goal: process a large codebase audit."));
    for (let i = 0; i < 450; i++) {
      const r = nextCallId();
      const e = nextCallId();
      entries.push(
        assistant(toolCallPart(r, "read", { path: `src/mod${i}/file.ts` })),
        toolResult(r, "read", `content ${i}`),
        assistant(toolCallPart(e, "edit", { path: `src/mod${i}/file.ts` })),
        toolResult(e, "edit", `edited ${i}`),
      );
    }
    // 1 + 450*4 = 1801 entries; pad to 2000 with assistant text lines.
    while (entries.length < 2000) entries.push(assistant(textPart(`progress note ${entries.length}`)));
    entries.push(user("Final review"));
    expect(entries.length).toBeGreaterThanOrEqual(2000);

    const start = performance.now();
    const result = compileFabricSummary(entries, 1000);
    const elapsed = performance.now() - start;
    expect("compaction" in result).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("compaction section composition", () => {
  it("captures git commit bash calls with their first output line", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c = nextCallId();
    const session = buildSession(
      user("commit it"),
      assistant(toolCallPart(c, "bash", { command: "git commit -m \"ship feature\"" })),
      toolResult(c, "bash", "[main abc1234] ship feature\n 1 file changed"),
      user("done"),
    );
    const events = normalizeEntries(session.slice(0, 3));
    const sections = project(events);
    expect(sections.commits.some((l) => l.includes("abc1234") && l.includes("ship feature"))).toBe(true);
  });

  it("renders a stable, section-ordered document", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c = nextCallId();
    const session = buildSession(
      user("goal line one\ngoal line two\ngoal line three\ngoal line four"),
      assistant(toolCallPart(c, "read", { path: "src/x.ts" })),
      toolResult(c, "read", "x"),
      user("second request"),
      assistant(textPart("ok")),
      user("final review"),
    );
    const { compaction } = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    // Goal truncated to 3 lines + ellipsis.
    expect(compaction.summary).toContain("goal line one");
    expect(compaction.summary).toContain("goal line three");
    expect(compaction.summary).toContain("…");
    expect(compaction.summary).toContain("- second request");
    expect(compaction.summary).not.toContain("- final review");
  });
});
