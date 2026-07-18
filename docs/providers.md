# External providers

Normal `pi.registerTool()` tools are [captured automatically](configuration.md#captured-extension-tools). Extensions can still opt into the versioned provider protocol when they need to expose non-tool capabilities, richer risk declarations, or a large virtual action catalog without registering one Pi tool per action.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Providers own their schemas, state, and execution semantics. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can enrich the generic [activity surface](interface.md#data-driven-activity) without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```
