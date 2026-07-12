import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { FabricState } from "../fabric-state.js";
import type { MeshEvent } from "../mesh/store.js";
import { FabricDashboard } from "./dashboard.js";
import { formatTokens, safeText } from "./format.js";
import { createDashboardSnapshot } from "./snapshot.js";
import { isActiveStatus, type FabricDashboardSnapshot } from "./types.js";
import { FabricWidget, shouldShowFabricWidget } from "./widget.js";

const WIDGET_ID = "pi-fabric";
const STATUS_ID = "pi-fabric";

const emptySnapshot = (): FabricDashboardSnapshot => ({
  now: Date.now(),
  runs: [],
  agents: [],
  actors: [],
  state: [],
  events: [],
});

export class FabricUiController {
  #context: ExtensionContext | undefined;
  #snapshot: FabricDashboardSnapshot = emptySnapshot();
  #events: MeshEvent[] = [];
  #meshOffset = 0;
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #widgetMounted = false;

  constructor(readonly state: FabricState) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.ui.enabled || context.mode !== "tui") return;
    if (this.state.config.mesh.enabled) {
      this.#events = this.state.mesh.read({ limit: this.state.config.ui.eventHistory });
      this.#meshOffset = this.state.mesh.latestOffset();
    }
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#refresh();
    this.#timer = setInterval(() => this.#refresh(), this.state.config.ui.refreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
      this.#context.ui.setStatus(STATUS_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#widgetMounted = false;
    this.#events = [];
    this.#meshOffset = 0;
    this.#snapshot = emptySnapshot();
  }

  async openDashboard(context: ExtensionContext): Promise<void> {
    if (context.mode !== "tui") {
      context.ui.notify("The Fabric dashboard is available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.ui.enabled) {
      context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning");
      return;
    }
    if (!this.#context) this.start(context);
    else this.#refresh();
    await context.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new FabricDashboard(tui, theme, () => this.#snapshot, () => done(undefined)),
      {
        overlay: true,
        overlayOptions: {
          width: "94%",
          minWidth: 40,
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        },
      },
    );
  }

  snapshot(): FabricDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  #scheduleRefresh(): void {
    if (this.#scheduledRefresh || !this.#context) return;
    this.#scheduledRefresh = setTimeout(() => {
      this.#scheduledRefresh = undefined;
      this.#refresh();
    }, 16);
    this.#scheduledRefresh.unref();
  }

  #refresh(): void {
    const context = this.#context;
    if (!context || !this.state.initialized) return;
    try {
      this.#pollMesh();
      this.#snapshot = createDashboardSnapshot(this.state, this.#events);
      this.#renderStatus(context);
      this.#renderWidget(context);
      this.#widgetTui?.requestRender();
    } catch {
      return;
    }
  }

  #pollMesh(): void {
    if (!this.state.config.mesh.enabled) return;
    const result = this.state.mesh.tail(this.#meshOffset, this.state.config.ui.eventHistory);
    this.#meshOffset = result.nextOffset;
    if (result.events.length === 0) return;
    this.#events.push(...result.events);
    const limit = this.state.config.ui.eventHistory;
    if (this.#events.length > limit) this.#events.splice(0, this.#events.length - limit);
  }

  #renderStatus(context: ExtensionContext): void {
    if (!this.state.config.ui.status || context.mode !== "tui") {
      context.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const candidateRun = this.#snapshot.runs[0];
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        this.#snapshot.now - (candidateRun.finishedAt ?? candidateRun.updatedAt) <=
          this.state.config.ui.lingerMs)
        ? candidateRun
        : undefined;
    const runningAgents = this.#snapshot.agents.filter((agent) => isActiveStatus(agent.status));
    const activeActors = this.#snapshot.actors.filter((actor) => isActiveStatus(actor.status));
    const activeState = this.#snapshot.state.filter((entry) => isActiveStatus(entry.status));
    if (!run && runningAgents.length === 0 && this.#snapshot.actors.length === 0 && activeState.length === 0) {
      context.ui.setStatus(STATUS_ID, undefined);
      return;
    }

    const theme = context.ui.theme;
    const parts: string[] = [];
    if (run) {
      const phase = run.phases.find((candidate) => candidate.id === run.currentPhaseId);
      parts.push(
        theme.fg(
          run.status === "failed" ? "error" : run.status === "running" ? "accent" : "success",
          safeText(phase?.name ?? run.name),
        ),
      );
    }
    if (runningAgents.length > 0) parts.push(theme.fg("accent", `⚡${runningAgents.length}`));
    if (this.#snapshot.actors.length > 0) {
      const actorErrors = this.#snapshot.actors.filter((actor) => actor.lastError).length;
      parts.push(
        theme.fg(
          actorErrors > 0 ? "error" : activeActors.length > 0 ? "warning" : "dim",
          `◉${this.#snapshot.actors.length}${actorErrors > 0 ? `!${actorErrors}` : ""}`,
        ),
      );
    }
    if (activeState.length > 0) parts.push(theme.fg("dim", `◆${activeState.length}`));
    const tokens = this.#snapshot.agents
      .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
      .reduce(
        (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
        0,
      );
    if (tokens > 0) parts.push(theme.fg("dim", `${formatTokens(tokens)}t`));
    context.ui.setStatus(STATUS_ID, `fabric: ${parts.join(theme.fg("dim", " · "))}`);
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.ui;
    const shouldShow =
      context.mode === "tui" &&
      shouldShowFabricWidget(this.#snapshot, config.widget, config.lingerMs);
    if (!shouldShow) {
      if (this.#widgetMounted) context.ui.setWidget(WIDGET_ID, undefined);
      this.#widgetMounted = false;
      this.#widgetTui = undefined;
      return;
    }
    if (this.#widgetMounted) return;
    this.#widgetMounted = true;
    context.ui.setWidget(
      WIDGET_ID,
      (tui, theme) => {
        this.#widgetTui = tui;
        return new FabricWidget(theme, () => this.#snapshot, config.maxRows, config.lingerMs);
      },
      { placement: config.placement },
    );
  }
}
