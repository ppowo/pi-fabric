# Fabric execution trace V1

Final `fabric_exec` result details are a bounded durable envelope containing only `success` and `trace`. Rich `audits`, logs, values, type errors, elapsed time, media, and raw runtime/provider errors remain in memory only and are not copied into final session JSONL details. Live partial updates may still carry richer audits for the active UI.

The complete serialized final details object is at most 512 KiB. Consumers should use the trace structurally and must not recover calls by parsing program source, rendered output, or audit prose.

## Envelope

```ts
interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  trace: FabricExecutionTraceV1;
}

interface FabricExecutionTraceV1 {
  kind: "pi-fabric.execution";
  version: 1;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  phases: string[];
  operations: FabricExecutionTraceOperationV1[];
  counts: {
    droppedValues: number;
    truncatedValues: number;
    redactedValues: number;
    droppedOperations: number;
  };
  error?: string;
}
```

The trace contains no run or call timestamps, elapsed durations, random call IDs, source code, media payloads, or arbitrary argument/result content. Runtime and call errors are fixed stage/outcome messages rather than provider, validator, approval, or guest exception prose.

`phases` is occurrence-ordered. Repeated transitions are retained, so `A → B → A` is represented as `["A", "B", "A"]`.

## Call operation

```ts
interface FabricExecutionTraceOperationV1 {
  type: "call";
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  args: Record<string, JsonValue>;
  outcome: "succeeded" | "failed" | "aborted" | "timed_out";
  failureStage?: "resolve" | "prepare" | "validate" | "approve" | "invoke" | "guard";
  error?: string;
  result?: JsonValue;
}
```

`sequence` is assigned when the host bridge receives a call. Parallel completion updates that record without changing operation order. An attempt is issued before reference resolution, preparation, schema validation, approval, and execution guards, so failures in those stages remain visible. QuickJS returns a typed termination reason; trace sealing uses that reason for deadline and cancellation outcomes and never classifies exception text.

V1 keeps `result` optional for wire compatibility. The generic recorder omits provider results except for the exact `{ created: true }` creation outcome from `pi.write`; no output or provider details accompany it. It projects arguments by exact built-in reference:

- `pi.read`: local `path`, numeric `offset`, numeric `limit`
- `pi.grep`: local `path`, numeric `context`, numeric `limit`; pattern/query omitted
- `pi.find`, `pi.ls`: local `path`, numeric `limit`; pattern/query omitted
- `pi.edit`, `pi.write`: local `path` only; edit replacements and write content omitted; `pi.write` may retain `{ created: true }`
- `pi.bash`: SHA-256 command digest only; command body omitted
- selected `agents.*` lifecycle calls: `id` only; task, message, instructions, names, model options, and outputs omitted
- `mesh.publish`/`read`: topic/address and numeric cursor/limit; payload text/data omitted
- `mesh.get`/`put`/`delete`/`list`: key or prefix and limit; values omitted
- memory, state, schema, compact, MCP, extension, unknown, and external calls: no arguments or results

Only plain local paths are retained. URL paths are omitted, including credentials and query/fragment data. Plain path query/fragment suffixes are removed. Sensitive-key normalization, media/base64 rejection, JSON safety, depth/node limits, and UTF-8 truncation remain defense in depth after projection; they are not the primary secrecy mechanism.

Identifiers (`ref`, `provider`, `action`), outcomes, failure stage, operation sequence, and occurrence-ordered phase labels remain durable. These fields and retained local paths/mesh addresses are metadata, not secret containers; callers must not intentionally place credentials in identifiers, local filenames, topics, keys, or phase names. Command digests reveal equality and are not keyed authentication codes.

## Reading and rendering traces

The package exports `isFabricExecutionTraceV1`, `isFabricExecutionTraceOperationV1`, `readFabricExecutionTraceV1`, `createFabricPersistedExecutionDetails`, and `readFabricExecutionRenderDetails`. Guards reject malformed envelopes, extra fields, oversized data, and unknown versions.

Current trace-only sessions reconstruct compact nested-call rows from operation metadata. Old sessions containing `details.audits` and `details.phases` continue to render through the legacy adapter, including their historical richer previews. New final details never write `audits`.

Compaction and memory read only `toolResult.details.trace` through the trace guard. Compaction emits phases and operations in sequence order with stable `entryId/subordinal` addresses, and memory emits one normalized child per operation with address `<outer-entry-id>/<sequence>`. Neither consumer parses `fabric_exec` source, outer output, operation results, or rendered audit prose to recover calls, files, or failures.

A present but invalid or unknown trace blocks semantic legacy reinterpretation. Only when the trace field is absent may compaction use its separate strict old-session `details.audits` adapter. Memory indexes trace operations only.

## Limitations

Safe projections intentionally reduce durable reconstruction. Final rendering cannot show read bodies, edit diffs, write bodies, agent tasks, external/MCP arguments, or provider results. Compaction cannot recover nested commit command prose from a bash digest, and generic failure resolution has ref identity only when arguments are omitted. Rich versions remain available only while the live execution result is in memory.
