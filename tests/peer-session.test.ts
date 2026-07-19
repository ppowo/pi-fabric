import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricMainAgentInfo } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { PEER_STALE_MS, PeerSessionRegistry } from "../src/peer-session.js";

const roots: string[] = [];
const registries: PeerSessionRegistry[] = [];

const setup = (root: string, sessionId: string, kind: MeshIdentity["kind"] = "main") => {
  const identity: MeshIdentity = {
    id: kind === "main" ? `session:${sessionId}` : `agent:${sessionId}`,
    name: kind === "main" ? "main" : "worker",
    kind,
    sessionId,
  };
  const context = {
    cwd: "/tmp/project",
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const startedAt = Date.now() - 1_000;
  const mainAgent = {
    info: (): FabricMainAgentInfo => ({
      id: kind === "main" ? identity.id : "session:root",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: context.cwd,
      sessionId: kind === "main" ? sessionId : "root",
      startedAt,
      updatedAt: Date.now(),
      pendingMessages: false,
      local: kind === "main",
    }),
  };
  const registry = new PeerSessionRegistry(
    new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
    identity,
    mainAgent,
    context,
    true,
  );
  registries.push(registry);
  return registry;
};

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PeerSessionRegistry", () => {
  it("discovers concurrent root sessions as peers and removes clean shutdowns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-peers-"));
    roots.push(root);
    const alpha = setup(root, "alpha-session");
    const beta = setup(root, "beta-session");

    await alpha.start();
    await beta.start();

    expect(alpha.list()).toMatchObject([
      {
        id: "session:beta-session",
        name: "Peer beta-ses",
        kind: "peer",
        status: "idle",
        sessionId: "beta-session",
        local: false,
      },
    ]);
    expect(beta.list().map((peer) => peer.id)).toEqual(["session:alpha-session"]);

    await beta.close();
    expect(alpha.list()).toEqual([]);
  });

  it("hides stale presence records after the heartbeat lease expires", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-peers-"));
    roots.push(root);
    const alpha = setup(root, "alpha");
    const beta = setup(root, "beta");
    await alpha.start();
    await beta.start();

    expect(alpha.list()).toHaveLength(1);
    expect(alpha.list(Date.now() + PEER_STALE_MS + 1)).toEqual([]);
  });

  it("does not advertise recursive agents as peer sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-peers-"));
    roots.push(root);
    const alpha = setup(root, "alpha");
    const worker = setup(root, "worker", "agent");
    await alpha.start();
    await worker.start();

    expect(alpha.list()).toEqual([]);
  });
});
