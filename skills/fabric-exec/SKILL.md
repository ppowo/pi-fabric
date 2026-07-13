---
name: fabric-exec
description: >-
  Reference for writing `fabric_exec` TypeScript programs in the QuickJS
  sandbox: the mental model (one program, return only the final value), the
  core `pi` tools (read/bash/edit/write/grep/find/ls) with exact signatures,
  `tools` discovery and introspection, `π` named strings, parallelization,
  and the validate, describe, retry error loop. Load before your first
  `fabric_exec` call and whenever a call errors on argument shape. For MCP,
  agents/rlm, and mesh, see `references/mcp.md`, `references/agents.md`, `references/mesh.md`.
---

# fabric_exec — core reference

`fabric_exec` runs one type-checked TypeScript program in a QuickJS sandbox. Only the value you `return` reaches the model; everything else stays in the sandbox. Load this skill before your first call and whenever a call errors on argument shape.

## Mental model

- One `fabric_exec` call is one program. Top-level `await` and `return` are supported. Hold loops, branches, and intermediate values in code; do not split a single task across many calls.
- Return only the compact final value. `print(...)` and `console.log` write to the Fabric activity panel for debugging; they are not returned.
- Parallelize independent calls with `Promise.all`.
- `π.<key>` exposes named strings passed via the `strings` parameter. Use it for content that is awkward to quote (shell commands, grep regex, large file text). Accessing a key you did not provide throws with the list of provided keys. `π` is not a tool: `π.read` throws and tells you to call `pi.read(args)`.

## Efficiency — batch, do not iterate

Every `fabric_exec` call is a full tool round-trip: request, sandbox, result. Using it as a thin one-call-per-`pi.*` wrapper forfeits the reason it exists. Compose many operations into one program and return a single compact value. Two patterns:

- **Independent operations → `Promise.all`.** Read several files or run related greps in one call.
  ```ts
  return await Promise.all([
    pi.read({ path: "a.ts" }),
    pi.read({ path: "b.ts" }),
    pi.grep({ pattern: "TODO" }),
  ]);
  ```

- **Ordered or dependent operations → sequential `await`.** When a later step needs an earlier result, keep them in the same program; do not split them into separate calls.
  ```ts
  const pkg = await pi.read({ path: "package.json" });
  const name = JSON.parse(pkg).name;
  return await pi.grep({ pattern: name, path: "src" });
  ```

Keep one compact `return`; use `print(...)` for debug traces. The anti-pattern is issuing one `fabric_exec` per `pi.read` or `pi.bash` and chaining turns — that multiplies round-trips and rarely beats calling core tools directly.

## The `pi` core tools (full code mode only)

`pi.<tool>(args)` takes a single argument. `read`, `bash`, `grep`, `find`, and `ls` accept a bare string (the primary field) or an options object; `edit` and `write` require an options object. No tool takes multiple positional arguments: `pi.grep(pattern, path)` is a type error; use `pi.grep({ pattern, path })`.

| Tool | Accepted forms | Returns |
|------|----------------|---------|
| `pi.read`  | `path` or `{ path, offset?, limit? }` | `string` |
| `pi.bash`  | `command` or `{ command, timeout? }` | `{ ok, output, details }` |
| `pi.grep`  | `pattern` or `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }` | `string` |
| `pi.find`  | `pattern` or `{ pattern, path?, limit? }` | `string` |
| `pi.ls`    | `path?` or `{ path?, limit? }` | `string` |
| `pi.edit`  | `{ path, edits: [{ oldText, newText }] }` or `{ path, oldText, newText }` | `{ ok, output, details }` |
| `pi.write` | `{ path, content }` | `{ ok, output, details }` |

Aliases accepted: `cmd` -> `command`, `query` -> `pattern` (find/grep), `file` -> `path` (read/ls/edit/write), `dir` -> `path` (ls).

```ts
const src = await pi.read("src/index.ts");
const hits = await pi.grep({ pattern: "TODO", path: "src" });
const r = await pi.bash({ command: "pnpm run typecheck", timeout: 180 });
return { hits, typecheck: r.output };
```

## `tools` — discovery and generic calls

Refs are provider-namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`. A bare name like `grep` is rejected.

- `tools.providers()` returns `[{ name, description }]`.
- `tools.search({ query, limit? })` returns `FabricAction[]` (each has `ref, name, description, inputSchema, risk`).
- `tools.describe({ ref })` returns the full `FabricAction`; read `inputSchema` before calling a tool whose shape you do not know.
- `tools.call({ ref, args? })` invokes by ref.
- `tools.list({ provider?, namespace?, query?, limit? })` and `tools.progress({ message })`.

```ts
const c = await tools.search({ query: "github issues" });
const schema = await tools.describe({ ref: c[0].ref });
return tools.call({ ref: schema.ref, args: { query: "is:open" } });
```

`extensions.<tool>(args)` calls a captured extension tool by its short name (full code mode only).

## Error recovery: validate, describe, retry

1. Read the line-numbered QuickJS error.
2. Introspect the tool: `await tools.describe({ ref: "pi.<tool>" })` or the `ref` from `tools.search`.
3. Match `inputSchema` and rerun. Do not guess signatures from memory.

Common mistakes: two positional arguments (`pi.grep(p, path)` should be `pi.grep({ pattern: p, path })`); a bare ref (`grep` should be `pi.grep`); building shell or regex strings with template literals that contain `${...}` (pass them via the `strings` parameter and read them as `π.key`).

## References — other surfaces

Load these by relative path (resolve against this skill's directory) when you need a surface beyond the core `pi` tools:

- `references/mcp.md` — `mcp.<server>.<tool>`, `mcp.servers`, `mcp.register`, `mcp.call`.
- `references/agents.md` — one-shot child agents, persistent mailbox actors, `rlm.query`.
- `references/mesh.md` — durable topics, compare-and-swap shared state, actor presence.

Workflow fan-out and multi-reviewer councils have `/skill:`-reachable pattern skills, `fabric-workflow` and `fabric-council`. Use them when the user requests a workflow or a council.
