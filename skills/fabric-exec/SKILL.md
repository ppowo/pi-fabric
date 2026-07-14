---
name: fabric-exec
description: >-
  Reference for writing `fabric_exec` TypeScript programs in the QuickJS
  sandbox: the mental model (one program, return only the final value), the
  core `pi` tools (read/bash/edit/write/grep/find/ls) with exact signatures,
  `tools` discovery and introspection, `π` named strings,
  and the validate, describe, retry error loop. Load before your first
  `fabric_exec` call and whenever a call errors on argument shape. MCP is
  discoverable via `tools`; see `references/mcp.md`.
---

# fabric_exec — core reference

One type-checked TS program in a QuickJS sandbox. Only the `return` value reaches the model; `print()`/`console.log` go to the activity panel. `π` is not a tool.

## `pi` core tools (full code mode only)
`pi.<tool>(arg)` — single arg: bare string (primary field) or options object; `edit`/`write` need an object. No positional args: `pi.grep(p, path)` → `pi.grep({ pattern: p, path })`.

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` | `string` |
| `bash` | `command` \| `{command,timeout?}` | `{ok,output,details}` |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` | `string` |
| `ls` | `path?` \| `{path?,limit?}` | `string` |
| `edit` | `{path,edits:[{oldText,newText}]}` \| `{path,oldText,newText}` | `{ok,output,details}` |
| `write` | `{path,content}` | `{ok,output,details}` |

Aliases: `cmd`→`command`, `query`→`pattern`, `file`→`path`, `dir`→`path`.

## `tools` — discovery & generic calls
Refs namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`; bare names rejected. `tools.providers()`→`[{name,description}]` · `tools.search({query,limit?})`→`FabricAction[]`(`ref,name,description,inputSchema,risk`) · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→`[{provider,id,name,key}]` (canonical `key` is `"provider/id"`; pass it to `agents.run`/`agents.create` `model` — a bare id may not resolve) · `extensions.<tool>(args)` (full code mode only).

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: two positional args; bare ref (`grep`→`pi.grep`).

## Other surfaces (opt-in)
MCP tools are discoverable via `tools` (`mcp.<server>.<tool>`); see `references/mcp.md`. Multi-agent orchestration is opt-in: load `/skill:fabric-workflow`, `/skill:fabric-council`, or `/skill:fabric-rlm` (API detail in `references/agents.md`, `references/mesh.md`).
