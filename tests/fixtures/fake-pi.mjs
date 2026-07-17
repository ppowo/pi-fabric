#!/usr/bin/env node
// A stub `pi` binary for the real-worker e2e. The Fabric worker spawns this as
// the child agent and talks to it over stdin/stdout JSON lines. Behavior is
// selected with the FAKE_PI_BEHAVIOR env var so the e2e can drive the real
// worker.ts + SubagentManager.#monitor across child outcomes.
const behavior = process.env.FAKE_PI_BEHAVIOR || "success";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

// Drain the prompt the worker writes so its stdin write does not block.
process.stdin.resume();
process.stdin.on("data", () => {});

switch (behavior) {
  case "exit-clean":
    process.exit(0);
  case "exit-error":
    process.exit(1);
  case "kill-worker":
    // Simulate the worker being hard-killed mid-run (OOM / external kill): it dies
    // before it can write a terminal status.
    try {
      process.kill(process.ppid, "SIGKILL");
    } catch {
      /* worker already gone */
    }
    process.exit(0);
  case "reject":
    emit({ type: "response", command: "prompt", success: false, error: "provider rejected the prompt" });
    process.exit(1);
  case "hang":
    // Never exit and never settle; the worker timeout should fire.
    setInterval(() => {}, 60_000);
    break;
  case "split-utf8": {
    const line = Buffer.from(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "界面 🚀" } }) + "\n",
    );
    const split = line.indexOf(Buffer.from("界")) + 1;
    process.stdout.write(line.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(line.subarray(split));
      emit({ type: "agent_settled" });
      process.exit(0);
    }, 10);
    break;
  }
  case "stderr-framing":
    process.stderr.write(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "spoofed" } }),
    );
    emit({ type: "message_end", message: { role: "assistant", content: "trusted" } });
    emit({ type: "agent_settled" });
    process.exit(0);
    break;
  case "success":
  default:
    emit({ type: "message_end", message: { role: "assistant", content: "hi" } });
    emit({ type: "agent_settled" });
    process.exit(0);
}
