import type { Sections } from "./projections.js";

// Deterministic serialization (principle 5). Fixed section order — stable,
// low-volatility sections first (goal, files, commits, outstanding, earlier
// turns, status), then the volatile brief transcript behind a `---` divider,
// then a footer. Only non-empty sections are emitted. The same event stream
// always produces byte-identical output: no clocks, no random ids, no
// key-order dependence. The footer's timestamp is derived from the last
// summarized entry's own timestamp (an input), never from "now", so the output
// stays reproducible across runs and prompt-cache friendly.

const SECTION_ORDER: { key: keyof Sections; header: string }[] = [
  { key: "goal", header: "[Session Goal]" },
  { key: "files", header: "[Files And Changes]" },
  { key: "commits", header: "[Commits]" },
  { key: "outstanding", header: "[Outstanding Context]" },
  { key: "earlierTurns", header: "[Earlier Turns]" },
  { key: "status", header: "[Current Status]" },
];

export interface RenderOptions {
  // Entry id of the first summarized message entry.
  firstEntryId: string;
  // Entry id of the last summarized message entry.
  lastEntryId: string;
  // ISO timestamp of the last summarized entry — used as the deterministic
  // "compacted at" marker. Empty string falls back to a fixed placeholder.
  lastTimestamp: string;
}

const POINTER_LINE =
  "For full pre-summary history, search the session log across this entry range (memory.recall / vcc_recall-style).";

export const renderSummary = (sections: Sections, options: RenderOptions): string => {
  const blocks: string[] = [];
  for (const { key, header } of SECTION_ORDER) {
    const lines = sections[key];
    if (lines.length === 0) continue;
    blocks.push([header, ...lines].join("\n"));
  }

  if (sections.transcript.length > 0) {
    blocks.push(["---", ...sections.transcript].join("\n"));
  }

  const timestamp = options.lastTimestamp || "(unknown time)";
  const range =
    options.firstEntryId || options.lastEntryId
      ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
      : "(no entries)";
  blocks.push(
    [
      "---",
      `[compacted ${timestamp}; summarized entries ${range}]`,
      POINTER_LINE,
    ].join("\n"),
  );

  return `${blocks.join("\n\n")}\n`;
};
