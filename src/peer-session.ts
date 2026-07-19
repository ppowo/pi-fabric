import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricMainAgentInfo } from "./main-agent.js";
import { MeshStore, type MeshIdentity, type MeshStateEntry } from "./mesh/store.js";

const PEER_PREFIX = "sessions/";
const PEER_HEARTBEAT_MS = 5_000;
export const PEER_STALE_MS = 15_000;

export interface FabricPeerInfo {
  id: string;
  name: string;
  kind: "peer";
  status: "idle" | "running";
  runner: "pi";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}

export interface FabricPeerSource {
  list(now?: number): FabricPeerInfo[];
}

const peerName = (sessionId: string): string => `Peer ${sessionId.slice(0, 8)}`;

const peerFromEntry = (entry: MeshStateEntry): FabricPeerInfo | undefined => {
  if (typeof entry.value !== "object" || entry.value === null || Array.isArray(entry.value)) {
    return undefined;
  }
  const value = entry.value as Partial<FabricPeerInfo>;
  if (
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "number" ||
    (value.status !== "idle" && value.status !== "running")
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : peerName(value.sessionId),
    kind: "peer",
    status: value.status,
    runner: "pi",
    transport: "host",
    cwd: value.cwd,
    sessionId: value.sessionId,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    startedAt: value.startedAt,
    updatedAt: entry.updatedAt,
    pendingMessages: value.pendingMessages === true,
    local: false,
  };
};

export class PeerSessionRegistry implements FabricPeerSource {
  #timer: NodeJS.Timeout | undefined;
  #version: number | undefined;
  #closed = false;

  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    readonly mainAgent: { info(context?: ExtensionContext): FabricMainAgentInfo },
    readonly context: ExtensionContext,
    readonly enabled: boolean,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled || this.identity.kind !== "main") return;
    this.#closed = false;
    this.#timer = setInterval(() => void this.#heartbeat().catch(() => undefined), PEER_HEARTBEAT_MS);
    this.#timer.unref();
    await this.#heartbeat().catch(() => undefined);
  }

  list(now = Date.now()): FabricPeerInfo[] {
    if (!this.enabled) return [];
    const ownMainId = this.mainAgent.info(this.context).id;
    return this.mesh
      .list(PEER_PREFIX, 200)
      .filter((entry) => now - entry.updatedAt <= PEER_STALE_MS)
      .flatMap((entry) => {
        const peer = peerFromEntry(entry);
        return peer && peer.id !== ownMainId ? [peer] : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (!this.enabled || this.identity.kind !== "main") return;
    try {
      await this.mesh.delete({
        key: this.#key(),
        ...(this.#version !== undefined ? { ifVersion: this.#version } : {}),
      });
    } catch {
      // A stale presence record expires even if shutdown cleanup loses a race.
    }
  }

  async #heartbeat(): Promise<void> {
    if (this.#closed) return;
    const main = this.mainAgent.info(this.context);
    const sessionId = main.sessionId ?? this.identity.sessionId ?? main.id;
    const value: FabricPeerInfo = {
      id: main.id,
      name: peerName(sessionId),
      kind: "peer",
      status: main.status === "running" ? "running" : "idle",
      runner: "pi",
      transport: "host",
      cwd: main.cwd ?? this.context.cwd,
      sessionId,
      ...(main.model ? { model: main.model } : {}),
      ...(main.thinking ? { thinking: main.thinking } : {}),
      startedAt: main.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      pendingMessages: main.pendingMessages,
      local: false,
    };
    const entry = await this.mesh.put({ key: this.#key(), value, identity: this.identity });
    this.#version = entry.version;
  }

  #key(): string {
    return `${PEER_PREFIX}${this.identity.sessionId ?? this.identity.id}`;
  }
}
