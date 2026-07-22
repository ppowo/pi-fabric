import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("prewalk prompt isolation", () => {
  it("does not add prewalk state or guidance to before_agent_start", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("before_agent_start"');
    const end = source.indexOf("registerFabricCommand", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = source.slice(start, end);
    expect(handler.toLowerCase()).not.toContain("prewalk");

    const guidelinesStart = source.indexOf("promptGuidelines: [");
    const guidelinesEnd = source.indexOf("parameters:", guidelinesStart);
    const guidelines = source.slice(guidelinesStart, guidelinesEnd).toLowerCase();
    expect(guidelines).not.toContain("prewalk");
    expect(guidelines).not.toContain("handoff");
  });

  it("runs handoff from finalized outer message_end without aborting nested calls", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("tool_result"');
    const end = source.indexOf('pi.on("tool_execution_end"', start);
    const boundaryHandlers = source.slice(start, end);

    expect(boundaryHandlers).toContain('pi.on("message_end"');
    expect(boundaryHandlers).toContain("state.runHandoffAtBoundary");
    expect(source).toContain("state.claimHandoff");
  });

  it("disarms the captured task from the agent_settled lifecycle", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("agent_settled"');
    const end = source.indexOf('pi.on("tool_call"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("state.prewalk.settleTask");
  });
});
