---
name: fabric-schema
description: Uses Fabric's typed Schema evidence loop and, when enabled, the host-owned bounded local-file transaction channel. Use when surprise must void a plan and mutation claims need explicit postconditions.
disable-model-invocation: true
---

# Fabric Schema

First read the active mode. Use the real generic provider API; `schema` and `state` are provider names, not guaranteed TypeScript globals.

```ts
const status = await tools.call({ ref: "schema.status", args: {} }) as {
  mode: "off" | "audit" | "enforce";
};
```

- `off` is the compatibility default. `state.*` can be used as workflow discipline, but it does not gate direct `pi.edit`, `pi.write`, or `pi.bash`.
- `audit` preserves current behavior and durably reports actions that enforce mode would block.
- `enforce` is a host authorization boundary for model-originated protected-workspace file changes. Direct mutations, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked. Use one same-`fabric_exec` `schema.hypothesize → schema.verify → schema.commit` sequence.

Evidence is not proof. A typed evidence item is a falsifiable observation or a host-configured check. Verification confirms that the item held at one fingerprinted workspace state. Postconditions confirm scoped observations after declared file operations. Passing either does not establish general semantic correctness.

## Enforce loop

Observe with allowed reads. Build literal or SHA evidence; use a trusted command only by a name supplied in trusted Fabric configuration. Never invent shell text: enforce-mode evidence has no command field or model arguments.

```ts
await pi.read({ path: "src/parser.ts" });

const hypothesis = await tools.call({
  ref: "schema.hypothesize",
  args: {
    label: "parser-local-form",
    summary: "Relative to the current head, the declared parser edit accepts the local form while focused tests remain green",
    evidence: [
      { kind: "file_contains", path: "src/parser.ts", literal: "old literal" },
      { kind: "trusted_command", name: "parser-focused-tests" }
    ]
  }
}) as { hypothesisId: string };

const verification = await tools.call({
  ref: "schema.verify",
  args: { hypothesisId: hypothesis.hypothesisId }
}) as {
  verified: boolean;
  certificate?: string;
  reason?: string;
  results: Array<{
    evidence: { kind: string; path?: string };
    status: "confirmed" | "nonconfirmed" | "error";
    observedSha256?: string;
  }>;
};

if (!verification.verified || !verification.certificate) {
  // Missing, empty, stale, nonconfirmed, errored, timed-out, cancelled, or
  // workspace-changing evidence voids the plan. Do not act.
  return verification;
}
const parserEvidence = verification.results.find(
  (result) => result.evidence.path === "src/parser.ts",
);
if (!parserEvidence?.observedSha256) return { void: true, reason: "missing observed SHA-256" };

const outcome = await tools.call({
  ref: "schema.commit",
  args: {
    hypothesisId: hypothesis.hypothesisId,
    certificate: verification.certificate,
    operations: [{
      kind: "edit",
      path: "src/parser.ts",
      oldText: "old literal",
      newText: "new literal",
      expectedSha256: parserEvidence.observedSha256
    }],
    postconditions: [
      { kind: "file_contains", path: "src/parser.ts", literal: "new literal" },
      { kind: "trusted_command", name: "parser-focused-tests" }
    ]
  }
});
return outcome;
```

Use `write` with `expected: { absent: true }` for a new file or `expected: { sha256 }` for replacement. Use `delete` with `expectedSha256`. Paths are project-relative regular files; path and symlink escape are rejected. Keep every operation local, declared, and small.

The certificate is random, short-lived, single-use, and bound to the hypothesis, state head/version, workspace fingerprint/generation, and current `fabric_exec` invocation. Do not return it for later use. Fabric abandons an uncommitted hypothesis/certificate when this invocation ends. Call `schema.abort` explicitly when stopping early:

```ts
await tools.call({
  ref: "schema.abort",
  args: { hypothesisId: hypothesis.hypothesisId, certificate: verification.certificate }
});
```

A commit result is `committed`, `rolled_back`, or `quarantined`. Treat only `committed` as success. `rolled_back` means declared paths were restored after failure. `quarantined` means rollback could not be fully established and needs operator inspection.

## Evidence vocabulary

- `{ kind: "file_exists", path }`
- `{ kind: "file_absent", path }`
- `{ kind: "file_contains", path, literal }` — literal containment, not a regex
- `{ kind: "file_sha256", path, sha256 }`
- `{ kind: "trusted_command", name }` — static host-configured executable/argv

Trusted commands are an explicit trusted computing base. They should be deterministic, local, and read-only. Tests and type checks are evidence for their scoped claim, not mathematical proof. Remote/network/database effects are not transactional and remain blocked in enforce mode.

For a claimed complexity reduction, set `complexityReduction: true` on the hypothesis and include behavior-preservation postconditions. Fabric reports it certified only after all postconditions pass; this does not turn tests into proof or objectively measure complexity.

## Off-mode state discipline

When mode is `off`, the older labeled state layer remains useful:

```ts
const transition = await tools.call({
  ref: "state.transition",
  args: {
    label: "claim",
    to: "claim-stated",
    summary: "A falsifiable delta",
    evidence: ["pnpm exec vitest run tests/focused.test.ts"]
  }
});
const verification = await tools.call({ ref: "state.verify", args: {} }) as {
  certified: boolean;
};
if (!verification.certified) return { void: true, transition, verification };
```

This is discipline over the typed state provider, not an enforcement boundary. `state` evidence and goals accept trusted workflow shell commands, unlike strict Schema evidence. In enforce mode those state write/execute actions are blocked; use `schema.*`.

See `docs/schema-enforcement.md` for the exact guarantee, trusted-command argv/shell behavior, fingerprint coverage, recovery model, and limitations. See `docs/state-layer.md` for the independent labeled state timeline.
