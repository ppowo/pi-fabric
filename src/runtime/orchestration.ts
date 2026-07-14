// Static detection of whether a fabric_exec program orchestrates child Pi
// agents, so FabricExecutionService can raise the whole-program executor
// deadline to at least the per-subagent deadline. Without this floor the
// short executor timeout can abort a program while its longer-running
// subagents are still within their own per-agent budget, which surfaces as
// every in-flight child returning "Subagent stopped".
//
// Match the subagent-spawning / awaiting entry points the model is taught to
// use, as call sites (a trailing "("), tolerating a single-level generic
// argument such as agent<{ items: string[] }>(...), while keeping false
// positives low:
//   - workflow.agent and the bare agent alias (the documented short form)
//   - agents.run / agents.wait / agents.ask (blocking one-shot and actor calls)
//   - council.run / rlm.query (convenience wrappers over agents.run)
// Read-only and non-blocking agents.* calls (list, status, spawn, create,
// tell) are intentionally excluded: they neither block the executor nor spawn
// a child whose lifetime it must cover. tools.call({ ref: "agents.run" }) is
// a rare, non-idiomatic spawn path and is not detected; the direct agents.run
// form is preferred and is what the skills teach.
const ORCHESTRATION_RE =
  /\b(?:workflow\.agent|agents\.(?:run|wait|ask)|council\.run|rlm\.query)\s*\(|(?<!\.)\bagent\s*(?:<[^<>]*>)?\s*\(/;

export const codeUsesOrchestration = (code: string): boolean =>
  ORCHESTRATION_RE.test(code);
