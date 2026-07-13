---
name: fabric-advisor
description: Starts a persistent Pi Fabric peer advisor that reviews the main agent at decision points (idle and tool errors) and surfaces only concrete, material advice. Use for ambient correctness review without another extension.
disable-model-invocation: true
---

# Fabric Advisor

Start an emergent advisor using `fabric_exec`; never install or invoke an external advisor extension.

Treat skill arguments as an optional review focus. Put the completed advisor prompt in `strings.instructions` and the stable name `advisor` in `strings.name`, then call `fabric_exec` once with:

```ts
await workflow.configure({
  name: `Advisor · ${π.name}`,
  description: "Persistent ambient peer review",
});
await phase("Start actor", { total: 1 });
const current = await agents.actors();
const existing = current.find((actor) => actor.name === π.name && actor.status !== "stopped");
if (existing) return { reused: true, actor: existing };

const actor = await agents.create({
  name: π.name,
  instructions: π.instructions,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: true,
  tools: ["read", "grep", "find", "ls"],
});
return {
  started: true,
  actor,
  inspect: `/fabric messages ${actor.id.slice(0, 8)}`,
  stop: `/fabric stop ${actor.id.slice(0, 8)}`,
};
```

Use this prompt and append the requested focus when one was supplied:

```text
You are an ambient peer advisor for the main coding agent. You review at decision points: when the agent settles (goes idle) and when a tool errors. Focus on correctness, missed user constraints, risky assumptions, edge cases, and cheaper paths to the requested outcome. You are not a second executor. You may inspect the workspace with read-only tools when evidence is needed.

Prefer silence. Return {"action":"silent"} when the agent is on track or productively advancing. Return {"action":"message","message":"..."} only for one concrete, material observation that could prevent wasted work or a defect, raised at a moment it can still help. Cite the evidence and recommendation tersely and frame it as advice to weigh, not an order. Do not repeat advice already visible in the recent transcript. Ignore minor style preferences unless the user made them requirements.
```

## Heuristic: review on good signals, not every turn

The advisor subscribes to `agent_settled` and `tool_error`, not `turn_end`. It runs at decision points (idle and on failures) and stays silent otherwise, so it does not invoke a model review on every turn. Intervene only on a concrete, high-confidence signal: a material correctness gap, a missed constraint, a risky assumption, or a tool error worth surfacing. This mirrors `../pi-supervisor/`, which analyzes at idle and on errors and otherwise trusts the agent to proceed.

After creation, report the focus, actor short ID, and inspect/stop commands. Do not wait for it. `triggerTurn: false` is intentional: delivered advice joins the main loop without forcing a new turn (advice to weigh, not an order).
