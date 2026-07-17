# Deterministic Compaction (the redistilled engine)

Pi Fabric ships a from-first-principles, LLM-free, regex-free compaction engine as a `session_before_compact` hook. It is the redistilled counterpart of the deterministic compaction proven in pi-vcc, rebuilt native to fabric without that dependency and without its accumulated prose heuristics.

This engine is **dark by default**: `compaction.engine` defaults to `"pi"`, so pi-core's own summarization runs unchanged. Set it to `"fabric"` to opt in.

```json
{
  "compaction": { "engine": "fabric" }
}
```

Put it in `~/.pi/agent/fabric.json` (global) or `<project>/.pi/fabric.json` (trusted project).

## Why a deterministic compactor

The Schema harness (ARC-AGI-3) proved that harness-enforced process beats prompt-level discipline, and pi-vcc proved a deterministic (LLM-free) compactor sustains 20+ compactions without goal degradation. pi-vcc's implementation, however, accumulated regex hacks over prose — most of which turned out to be ornamental. This module is the redistillation: the minimal clean core that reproduces the property, and a demonstration that the regex layers were ornament, not load-bearing.

## First principles

These are not negotiable.

0. **The context is a cache, not the store.** The session JSONL is ground truth and persists. The summary's job is continuation competence + addressability — never to store re-fetchable content, only its *address* (paths, entry ids, `(#index)` refs).
1. **The summary is a pure function of the raw log, never of the previous summary.** Every compaction recomputes from the raw branch entries of the live window. This kills drift by construction across N compactions: there is no chain of summaries to accumulate error.
2. **Structure over semantics.** Extract only what typed event structure gives — roles, tool names, JSON arguments, exit codes, `isError`, positions. No regex over prose in the core. Anything needing prose understanding is an optional, isolated enricher behind an interface.
3. **Salience is computed, not remembered.** Unresolved-ness is a state machine over the event stream: an error with no subsequent resolving event is still open. The core cannot "forget" an unresolved error because it never "remembered" it — it recomputes the state every time.
4. **Decay is graded, not binary.** Verbatim tail → collapsed transcript → one-line earlier turns.
5. **Deterministic serialization.** Fixed section order (stable first, volatile last); the same event stream always produces byte-identical output; prompt-cache friendly. There is no clock in the output — the footer's timestamp is the last summarized entry's own timestamp, an input.

## Pipeline

```
branch entries ──► computeCut ──► normalize ──► project ──► enrichers ──► render ──► summary
   (raw)            (boundary)    (typed        (section     (optional)   (stable
                                   events)       folds)                    bytes)
```

- **`normalize.ts`** — `SessionEntry[] → CompactionEvent[]`. A flat, typed event stream: `user`, `assistantText`, `thinking`, `toolCall{name,args}`, `toolResult{isError,text}`, `bash{command,exitCode,output}`. Tool results are paired back to their calls by `toolCallId` so a bash result carries the command from the originating call. Pairing is structural (id match), never prose-based. `!`-prefixed user bash (`bashExecution` messages) and the model-invoked `bash` tool unify into the same `bash` event.
- **`projections.ts`** — one pure fold per section, returning string lines. `project()` runs them all.
- **`enrichers.ts`** — the `CompactionEnricher` interface for optional, isolated, format-specific annotation. The core ships **zero** built-in enrichers; prose understanding is additive and plug-in, never in the core path.
- **`render.ts`** — stable serialization. Fixed section order, only non-empty sections emitted, footer with the entry-id range and a recall pointer.
- **`hook.ts`** — `computeCut` (pure, exported) and `registerCompactionHook`, which produces a `CompactionResult` pi-core accepts.

## Section composition

Fixed order, stable/low-volatility first, volatile last. Empty sections are omitted entirely.

| Section | Source | Decay tier |
| --- | --- | --- |
| `[Session Goal]` | First user message verbatim (≤3 lines); every later user message as a one-liner. The user's words *are* the goal — quote, don't paraphrase. | stable |
| `[Files And Changes]` | From tool-call args only: `read/grep/find/ls ⇒ Read`, `edit ⇒ Modified`, `write ⇒ Created`, recorded when the paired result succeeded. Paths trimmed to their common root. Addresses, never content (principle 0). | stable |
| `[Commits]` | `bash` tool calls whose command starts with `git commit`, paired with the first output line. | stable |
| `[Outstanding Context]` | The error state machine (principle 3) — highest value. `toolResult isError` and `bash` failures, tagged `[ERROR]`/`[WARN]`/`[INFO]` by source. An item becomes `[RESOLVED]` when a later event edits the same path successfully or re-runs the same command with success. Unresolved items listed first. | stable |
| `[Earlier Turns]` | One line per turn (all but the last): a quoted user one-liner + a tool-name histogram. | collapsed |
| `[Current Status]` | The last summarized user request, the last file-modifying tool call, and the last assistant line — a bridge into the kept tail. | collapsed |
| `---` transcript | Rolling ~120-event window of collapsed one-liners, each with a stable `(#N)` reference. | verbatim-ish tail |
| `---` footer | `[compacted <last-entry-timestamp>; summarized entries <firstId> → <lastId>]` + a pointer telling the agent to use `memory.recall` / `vcc_recall`-style search for pre-summary history. | footer |

Why this composition: the section order puts drift-prone, high-salience, and slow-changing facts at the top (where prompt caching keeps them stable) and the volatile transcript at the bottom (where it changes every compaction and does not invalidate the cached prefix). Graded decay (principle 4) falls out naturally: oldest turns → one line; recent events → collapsed one-liners with refs; the very last action → status.

## Why the regex-heavy layers are ornamental

The previous implementation extracted symbols, type catalogs, causal breadcrumbs, and prose summaries using regex over tool output and assistant text. None of that is load-bearing for continuation competence or addressability:

- **Symbols and type catalogs** duplicate what the agent re-derives by reading the file; they bloat the summary and drift from the source of truth. Principle 0 says store the *address*, not the content — the path is enough.
- **Causal breadcrumbs / prose extraction** require understanding prose, which is exactly what a deterministic core must not do (principle 2). They were layered on as regex, which is fragile and environment-sensitive.
- **Iterative summary chaining** (feeding the previous summary back in) is the root cause of drift. Recomputing from the raw window every time (principle 1) makes drift impossible by construction.

What survives is purely structural: roles, tool names, JSON args, `isError`, exit codes, entry ids, and positions. That is enough to compute salience (the error state machine) and addressability (paths + `(#N)` refs + entry-id range), which is what continuation competence actually needs.

## The enricher interface

```ts
import type { CompactionEnricher } from "pi-fabric/compaction/enricher";
// (or the internal path when contributing from inside the repo)

const tscEnricher: CompactionEnricher = {
  name: "tsc-line-extractor",
  applies(events) {
    return events.some((e) => e.kind === "bash" && e.command.includes("tsc"));
  },
  contribute(events, sections) {
    // Add format-specific annotation derived from events. Must be deterministic.
  },
};
```

The interface:

- `name` — stable identifier.
- `applies(events)` — cheap predicate; the core skips `contribute` when false.
- `contribute(events, sections)` — mutate `sections` in place. The full event stream is available so the enricher can derive its own state without re-walking the raw log differently from the core.

Contract: an enricher must be **deterministic** — the same event stream must yield the same contribution — so the overall serialization stays byte-identical for a given input (principle 5). Enrichers run after the structural sections are computed and may append to or replace any section. The core ships none; the registration path is exercised by `NO_BUILTIN_ENRICHERS` so it stays ready.

## The cut

`computeCut` (in `hook.ts`, pure and exported for testing) recomputes the boundary from the raw branch entries — never from pi-core's prepared slice and never from the previous summary:

1. Find the last compaction entry; collect the live window (from its `firstKeptEntryId` if it exists, else right after it; handles the compact-all sentinel and orphan recovery).
2. Cut at the **last user message**.
3. If the turn after the cut has unmatched tool calls (still in flight), push the cut back to the **previous user message** — keeping the in-progress turn in the tail.
4. If no earlier complete-turn boundary exists, fall back to the **compact-all sentinel** (`firstKeptEntryId = ""`), which pi-core treats as "keep nothing from before"; the deterministic summary then stands in for the whole window.

Because the cut always lands at a turn boundary (a user message), a tool call and its result are always on the same side of the cut — the cut never orphans a `tool_result` from its `tool_call`. Empty history cancels; tiny history falls back to compact-all and still produces a stable summary.

## Flipping the engine

Set `compaction.engine` to `"fabric"`:

```json
{ "compaction": { "engine": "fabric" } }
```

To go back to pi-core's LLM summarization, set it to `"pi"` (or remove the block). The hook returns early for the default engine, so pi-core proceeds normally — there is no behavioral change unless you opt in.

## What this engine does *not* do

- It makes no LLM calls. Summarization is structural and instant.
- It does not parse prose. The `bash` "exit code" signal is `isError` for the bash tool and the typed `exitCode` field for `!`-prefixed user bash; nothing regexes the output text.
- It does not chain summaries. Each compaction is recomputed from the raw live window.
- It does not store content. Files are recorded as paths (addresses), not their contents.
