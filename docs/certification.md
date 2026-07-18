# Context and memory certification

This repository has two separate evaluation paths:

- `pnpm certify:context` is deterministic, offline, and non-billable.
- `pnpm benchmark:real-resume` is an opt-in, billable Pi RPC benchmark. Its default behavior is a safe skip.

Neither command is part of `pnpm test`. The normal test suite remains offline and fast.

## Deterministic certification

Run on Node 24 or newer:

```sh
pnpm certify:context
pnpm certify:context -- --json /tmp/pi-fabric-certification.json
```

The package command builds `dist/` first, then runs `scripts/certify-context.mjs`. It prints a human summary followed by the complete JSON report and exits nonzero when any threshold fails.

### Compaction endurance

The harness creates a persisted session through Pi's `SessionManager`, appends messages and compactions through its public methods, and reads the active parent-linked branch with `getBranch()`. It performs exactly 100 Fabric compactions. A prior summary is stored only in the real `compaction` entry; it is never passed as prose to the next compile.

Every cycle checks:

- the original goal, constraint, and pinned Unicode rare fact;
- cumulative source, file, and unresolved-error addresses;
- tool-call/result closure at the kept boundary;
- that a nonempty `firstKeptEntryId` exists on the active branch;
- exclusion of a poison marker from prior summary prose;
- byte-identical summary and details from duplicate compilation of the same branch;
- a UTF-8 summary size no larger than 32 KiB.

The last 20 summary sizes must have a range no larger than 512 bytes and an absolute least-squares slope no larger than 16 bytes per cycle. These bounds detect late unbounded growth without requiring every cycle to have the same size.

This proves deterministic cumulative projection and boundary behavior for the generated typed event stream. It does not prove semantic quality for arbitrary human conversations or model behavior.

### Cross-layer memory

The same run creates 1,000 additional persisted Pi sessions. The unique rare-fact session receives an old source mtime and must be classified cold while only eight sessions remain hot. Certification calls `MemoryProvider` directly rather than parsing shell output.

The pass conditions are:

- at least 1,000 eligible sessions and complete indexing coverage;
- exact lexical recall of the cold rare fact;
- exact source expansion by its stable entry ID;
- exact expansion of every distinct entry ID emitted by the 100 compaction summaries or their structured details;
- 100% address expansion agreement with a fresh normalization of the source JSONL.

The JSON report includes eligible/indexed/stale counts, emitted/expanded address counts, and cache/source byte sizes.

This proves addressability through the current cache, digest, search, and source-expansion layers. It does not prove fuzzy semantic retrieval, ranking under unrelated corpora, cache performance on all filesystems, or recovery after source deletion.

### Continuation QA

Continuation QA creates two small temporary repositories. Each has exact expected final files, an executable Node oracle, and files that must remain byte-identical. A no-model handoff simulator receives only:

1. the compacted summary and structured compaction details; and
2. a constrained recall callback.

The simulator follows the cumulative source address, expands the addressed `CERT_TASK_V1` entry through `MemoryProvider`, applies its structured operations, and then runs the external process test. The primary score is exact filesystem state, forbidden-file integrity, and test exit status—not section or substring containment.

This proves that the emitted address and an allowed recall operation can carry these mechanically executable tasks across a handoff. It does not claim that arbitrary prose can be converted into operations, that a model will choose to recall, or that the two fixtures represent all software work.

## Real Pi RPC benchmark

The benchmark compares three arms in deterministic randomized paired order:

- `baseline`: resume the full, uncompacted context;
- `fabric`: compact with Fabric, terminate that process, then resume in a fresh process;
- `pi-vcc`: issue `compact` with the exact `__pi_vcc__` sentinel while both Fabric and the configured pi-vcc extension are loaded, terminate that process, then resume in a fresh process.

The resumed process receives exactly:

```text
Resume and complete the task.
```

A filesystem/test oracle outside the model scores the result. Reports capture pass/fail diff reasons, tokens, USD cost, tool calls, recall calls, wall time, summary bytes, Wilson 95% pass-rate intervals, and paired win/tie rates. Reports include the credential variable's name but never its value. Session and repository data live in a temporary directory and are removed after the run.

The RPC reader implements strict LF JSONL framing. It splits only on `\n`, strips an optional trailing `\r`, preserves U+2028/U+2029 inside JSON strings, and does not use Node's `readline`.

### Safety gate

Running this command without configuration exits zero and reports `SKIP`:

```sh
pnpm benchmark:real-resume
```

A billable run requires every gate below:

```sh
PI_FABRIC_REAL_RESUME=1 \
PI_FABRIC_BENCH_PROVIDER=anthropic \
PI_FABRIC_BENCH_MODEL=claude-sonnet-4-5 \
PI_FABRIC_BENCH_KEY_ENV=ANTHROPIC_API_KEY \
PI_FABRIC_BENCH_REPEATS=3 \
PI_FABRIC_BENCH_MAX_USD=5 \
PI_VCC_EXTENSION=/absolute/path/to/pi-vcc/extension.ts \
pnpm benchmark:real-resume
```

`PI_FABRIC_BENCH_KEY_ENV` names an already-set credential environment variable. The benchmark checks observed session cost before starting each next arm and stops once the configured budget has been reached. A single in-flight request can exceed the remaining budget, so the maximum is a stop boundary, not a provider-side hard spending cap.

The benchmark proves end-to-end behavior only for the selected model, provider, fixture, extension versions, and repeats. Small samples have wide confidence intervals. It does not establish general superiority or isolate every source of provider variance.

## Relationship to pi-vcc stress tooling

The neighboring pi-vcc stress scripts informed the useful ideas of repeated compaction, late-size measurements, paired real-session comparisons, and explicit recall accounting. This harness does not copy their regex-based section scoring, feed the previous rendered summary as the next source, or claim their assumptions. Fabric certification instead uses Pi parent-linked session entries, structured compaction details, direct memory APIs, exact source expansion, and executable continuation oracles.

## Test coverage

`tests/certification/` covers:

- strict LF JSONL parsing, including split UTF-8 and Unicode line separators;
- the default skip gate and complete opt-in gate;
- deterministic paired order and benchmark confidence/paired reporting;
- executable continuation oracle passes and forbidden-change failures;
- certification report threshold failures.
