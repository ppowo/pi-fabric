import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricTranscriptEntry } from "./transcript.js";
import type { FabricUiWidgetMode } from "../config.js";
import type {
  FabricActivityRun,
  FabricActivityStatus,
} from "../activity/types.js";
import { formatDuration, formatTokens, safeText } from "./format.js";
import {
  isActiveStatus,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
} from "./types.js";

const spinnerFrames = ["◐", "◓", "◑", "◒"];

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  return spinnerFrames[Math.floor(Date.now() / 250) % spinnerFrames.length] ?? "●";
};

const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out") return theme.fg("error", value);
  if (status === "blocked") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress") return theme.fg("accent", value);
  return theme.fg("dim", value);
};

const phaseProgress = (
  run: FabricActivityRun,
  phaseId: string,
): { completed: number; total: number } => {
  const phase = run.phases.find((candidate) => candidate.id === phaseId);
  const statuses: FabricActivityStatus[] = [
    ...run.calls.filter((call) => call.phaseId === phaseId).map((call) => call.status),
    ...run.items.filter((item) => item.phaseId === phaseId).map((item) => item.status),
  ];
  const completed = statuses.filter((status) => status === "completed").length;
  return { completed, total: Math.max(phase?.total ?? 0, statuses.length) };
};

const totalTokens = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );

const toolHeadline = (entry: FabricTranscriptEntry): string => {
  const args = entry.args ?? {};
  const name = entry.toolName ?? entry.label;
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : undefined;
  const command = typeof args.command === "string" ? args.command.split("\n")[0] : undefined;
  const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
  const detail = path ?? command ?? (pattern ? `/${pattern}/` : undefined);
  return detail ? `${name} ${safeText(detail)}` : name;
};

const firstChangedLine = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value.split("\n").map((line) => line.trim()).find(Boolean);
};

const toolChangeLines = (theme: Theme, entry: FabricTranscriptEntry, indent: string): string[] => {
  const args = entry.args ?? {};
  const name = (entry.toolName ?? entry.label).toLowerCase();
  if (name === "edit") {
    const edits = Array.isArray(args.edits)
      ? args.edits
      : typeof args.old_string === "string" && typeof args.new_string === "string"
        ? [{ oldText: args.old_string, newText: args.new_string }]
        : [];
    const first = edits[0];
    if (!first || typeof first !== "object" || first === null) return [];
    const record = first as Record<string, unknown>;
    const removed = firstChangedLine(record.oldText);
    const added = firstChangedLine(record.newText);
    return [
      ...(removed ? [`${indent}${theme.fg("toolDiffRemoved", `- ${safeText(removed)}`)}`] : []),
      ...(added ? [`${indent}${theme.fg("toolDiffAdded", `+ ${safeText(added)}`)}`] : []),
    ];
  }
  if (name === "write") {
    const added = firstChangedLine(args.content);
    return added ? [`${indent}${theme.fg("toolDiffAdded", `+ ${safeText(added)}`)}`] : [];
  }
  return [];
};

const agentLines = (
  theme: Theme,
  agent: FabricUiAgent,
  now: number,
  owner: "agent" | "actor" = "agent",
): string[] => {
  const status = colorStatus(theme, agent.status, statusGlyph(agent.status));
  const activity =
    agent.currentTool ??
    (agent.error
      ? `error: ${truncateToWidth(safeText(agent.error), 48)}`
      : agent.text && !isActiveStatus(agent.status)
        ? `result: ${truncateToWidth(safeText(agent.text), 48)}`
        : agent.status === "running"
          ? "thinking"
          : agent.status);
  const metrics = [
    agent.toolCalls !== undefined ? `${agent.toolCalls} calls` : undefined,
    agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
    agent.startedAt
      ? formatDuration((agent.finishedAt ?? now) - agent.startedAt)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const indent = agent.parentId ? "    " : "  ";
  const ownerTag = theme.fg("dim", `[${owner} · ${agent.runner ?? "pi"} · ${agent.id.slice(0, 8)}]`);
  const lines = [
    `${indent}${status} ${safeText(agent.name)}  ${theme.fg("muted", safeText(activity))}${
      metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
    }`,
  ];
  for (const tool of agent.toolActivity ?? []) {
    const toolIndent = `${indent}  `;
    const glyph = colorStatus(theme, tool.status ?? "completed", statusGlyph(tool.status ?? "completed"));
    lines.push(`${toolIndent}${glyph} ${theme.fg("toolTitle", toolHeadline(tool))} ${ownerTag}`);
    lines.push(...toolChangeLines(theme, tool, `${toolIndent}  `));
  }
  return lines;
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  if (snapshot.agents.some((agent) => isActiveStatus(agent.status))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  const run = snapshot.runs[0];
  if (!run) return false;
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ?? run.updatedAt;
  return finishedAt > (snapshot.widgetDismissedAt ?? 0);
};

export class FabricWidget implements Component {
  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
  ) {}

  #lastWidth: number | undefined;
  #lastLines: string[] | undefined;
  #leaseKey: string | undefined;
  #leasedRows = 0;

  render(width: number): string[] {
    if (width <= 0) return [];
    const { lines: content, leaseKey } = this.#buildContent();
    const lines = this.#leaseContent(this.#boundContent(content, width), leaseKey);
    this.#lastWidth = width;
    this.#lastLines = lines;
    return lines;
  }

  hasChanged(): boolean {
    if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
    const { lines: content, leaseKey } = this.#buildContent();
    const lines = this.#leaseContent(
      this.#boundContent(content, this.#lastWidth),
      leaseKey,
    );
    return JSON.stringify(lines) !== JSON.stringify(this.#lastLines);
  }

  invalidate(): void {}

  #buildContent(): { lines: string[]; leaseKey: string } {
    const snapshot = this.snapshot();
    const candidateRun = snapshot.runs[0];
    const candidateFinishedAt = candidateRun?.finishedAt ?? candidateRun?.updatedAt ?? 0;
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        candidateFinishedAt > (snapshot.widgetDismissedAt ?? 0))
        ? candidateRun
        : undefined;
    const orderedAgents = orderAgentsByCreation(snapshot.agents);
    const activeAgents = orderedAgents.filter((agent) => isActiveStatus(agent.status));
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
    const terminalAgents = run
      ? orderedAgents.filter(
          (agent) =>
            agent.runId === run.id &&
            !activeAgentIds.has(agent.id) &&
            !isActiveStatus(agent.status),
        )
      : [];
    const visibleActors = snapshot.actors.filter((actor) => actor.status !== "stopped");
    const activeActorWorkers = visibleActors
      .filter((actor) => actor.worker && isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name }));
    const terminalActorWorkers = visibleActors
      .filter((actor) => actor.worker && !isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name }));
    const nestedCalls =
      run?.calls.filter((call) => call.kind !== "agent" && call.kind !== "actor") ?? [];
    const title = run?.name ?? "Fabric session";
    const headerStatus =
      run?.status ??
      (activeAgents.length > 0 || activeActorWorkers.length > 0 ? "running" : "idle");
    const parts: string[] = [];

    const callTotal = nestedCalls.length;
    if (callTotal > 1) {
      const callDone = nestedCalls.filter(
        (call) => call.status === "completed" || call.status === "failed",
      ).length;
      parts.push(`${callDone}/${callTotal} calls`);
    }
    if (run?.currentPhaseId) {
      const phaseIndex = run.phases.findIndex((phase) => phase.id === run.currentPhaseId);
      const phase = run.phases[phaseIndex];
      if (phase) {
        const progress = phaseProgress(run, phase.id);
        parts.push(
          `${phaseIndex + 1}/${run.phases.length} ${safeText(phase.name)}${
            progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ""
          }`,
        );
      }
    }
    if (activeAgents.length > 0) parts.push(`${activeAgents.length} running`);
    if (visibleActors.length > 0) parts.push(`${visibleActors.length} actor${visibleActors.length === 1 ? "" : "s"}`);
    const tokens = totalTokens(snapshot, run);
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    if (run) parts.push(formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt));

    const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
    const header = `${glyph} ${this.theme.fg("accent", "Fabric")} ${this.theme.fg(
      "text",
      safeText(title),
    )}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
    const lines = [header];

    lines.push(
      ...activeAgents.flatMap((agent) => agentLines(this.theme, agent, snapshot.now)),
      ...activeActorWorkers.flatMap((agent) =>
        agentLines(this.theme, agent, snapshot.now, "actor"),
      ),
      ...terminalActorWorkers.flatMap((agent) =>
        agentLines(this.theme, agent, snapshot.now, "actor"),
      ),
      ...terminalAgents.flatMap((agent) => agentLines(this.theme, agent, snapshot.now)),
    );
    const ambientOwners = [
      ...activeAgents.map((agent) => `agent:${agent.id}`),
      ...visibleActors.map(
        (actor) => `actor:${actor.id}:${actor.worker?.id ?? actor.lastRunId ?? "idle"}`,
      ),
    ];
    return {
      lines,
      leaseKey: run?.id ?? (ambientOwners.length > 0 ? `ambient:${ambientOwners.join(",")}` : "ambient"),
    };
  }

  #leaseContent(lines: string[], leaseKey: string): string[] {
    if (this.#leaseKey !== leaseKey) {
      this.#leaseKey = leaseKey;
      this.#leasedRows = lines.length;
    } else {
      this.#leasedRows = Math.max(this.#leasedRows, lines.length);
    }
    if (lines.length >= this.#leasedRows) return lines;
    return [
      ...lines,
      ...Array.from({ length: this.#leasedRows - lines.length }, () => ""),
    ];
  }

  #boundContent(content: string[], width: number): string[] {
    const bounded = content.slice(0, Math.max(1, this.maxRows));
    if (content.length > bounded.length && bounded.length > 0) {
      const marker = this.theme.fg("dim", `+${content.length - bounded.length}`);
      const available = Math.max(0, width - visibleWidth(marker) - 1);
      const last = truncateToWidth(bounded[bounded.length - 1] ?? "", available, "");
      bounded[bounded.length - 1] = `${last} ${marker}`;
    }
    return bounded.map((line) => truncateToWidth(line, width));
  }
}
