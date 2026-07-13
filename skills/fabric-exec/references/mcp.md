# MCP surface reference

MCP tools are available inside `fabric_exec` through the `mcp` surface, backed by the public `mcporter` runtime (config discovery, imports, OAuth cache, connection pooling). For the sandbox model and `tools` discovery, see the parent `fabric-exec` skill.

## Call a tool

`mcp.<server>.<tool>(args)` takes a single options object matching the tool input schema. The server and tool names are whatever mcporter loaded.

```ts
const result = await mcp.context7.resolve_library_id({ libraryName: "react", query: "hooks" });
return result;
```

## Server management

- `mcp.servers()` returns server metadata `{ name, description, transport }` (description may be null; transport is "http" or "stdio"). Credentials are never exposed.
- `mcp.reload()` returns `{ servers }`. Call it after changing mcporter configuration.
- `mcp.register({ name, description?, command?, args?, cwd?, baseUrl?, headers?, env?, overwrite? })` returns `{ registered }`. Register an ephemeral server in the pooled runtime after host approval. HTTP servers use `baseUrl` instead of `command`. Dynamic definitions live until `mcp.reload()` or session shutdown; they are not written to config.

```ts
await mcp.register({ name: "project-docs", command: "npx", args: ["-y", "@example/docs-mcp"], cwd: "." });
return mcp.project_docs.search({ query: "authentication" });
```

## Generic call

`mcp.call({ server, tool, args? })` is for when a server or tool name cannot be expressed as property access.

```ts
return mcp.call({ server: "my-server", tool: "weird-tool-name", args: { q: "x" } });
```

## Introspect an uncertain tool

MCP tools are discoverable through the generic `tools` surface; refs are `mcp.<server>.<tool>`.

```ts
const schema = await tools.describe({ ref: "mcp.context7.resolve_library_id" });
// schema.inputSchema is the tool JSON Schema
```

## Notes

- When `mcp.disableOAuth` is configured, calls may use cached credentials but cannot launch a new interactive OAuth flow.
- Call timeout is bounded by `mcp.callTimeoutMs`.
- Set `mcp.enabled: false` to disable the MCP surface.
