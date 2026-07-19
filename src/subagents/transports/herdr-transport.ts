import net from "node:net";
import { randomUUID } from "node:crypto";
import type {
  SubagentTransportAdapter,
  SubagentTransportHandle,
  SubagentTransportLaunch,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 3_000;

interface HerdrErrorResponse {
  error?: { code?: string; message?: string };
}

interface HerdrLayoutApplyResponse extends HerdrErrorResponse {
  result?: {
    type?: string;
    layout?: {
      tab_id?: string;
      root?: { type?: string; pane_id?: string };
    };
  };
}

interface HerdrPaneResponse extends HerdrErrorResponse {
  result?: {
    type?: string;
    pane?: { pane_id?: string; terminal_id?: string };
  };
}

const endpointFor = (socketPath: string): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

const responseError = (response: HerdrErrorResponse): Error | undefined => {
  if (!response.error) return undefined;
  const code = response.error.code ? `${response.error.code}: ` : "";
  return new Error(`Herdr API request failed: ${code}${response.error.message ?? "unknown error"}`);
};

export class HerdrTransport implements SubagentTransportAdapter {
  readonly kind = "herdr" as const;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async available(): Promise<boolean> {
    if (
      this.environment.HERDR_ENV !== "1" ||
      !this.environment.HERDR_SOCKET_PATH ||
      !this.environment.HERDR_WORKSPACE_ID
    ) {
      return false;
    }
    try {
      await this.#request({ method: "ping", params: {} });
      return true;
    } catch {
      return false;
    }
  }

  async launch(request: SubagentTransportLaunch): Promise<SubagentTransportHandle> {
    const workspaceId = this.environment.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new Error("Herdr transport requires HERDR_WORKSPACE_ID");
    const response = (await this.#request({
      method: "layout.apply",
      params: {
        workspace_id: workspaceId,
        tab_label: request.name,
        focus: false,
        root: {
          type: "pane",
          label: request.name,
          cwd: request.cwd,
          command: [process.execPath, request.workerPath, ...request.workerArguments],
        },
      },
    })) as HerdrLayoutApplyResponse;
    const paneId = response.result?.layout?.root?.pane_id;
    if (response.result?.type !== "layout_apply" || !paneId) {
      throw new Error("Herdr layout.apply did not return a pane id");
    }

    let terminalId: string | undefined;
    try {
      const pane = (await this.#request({
        method: "pane.get",
        params: { pane_id: paneId },
      })) as HerdrPaneResponse;
      terminalId = pane.result?.pane?.terminal_id;
    } catch {
      // Very short runs can exit before the optional attach metadata is read.
    }

    return {
      kind: this.kind,
      sessionId: paneId,
      ...(terminalId ? { attachCommand: `herdr terminal attach ${terminalId}` } : {}),
      isAlive: async () => {
        try {
          await this.#request({ method: "pane.get", params: { pane_id: paneId } });
          return true;
        } catch {
          return false;
        }
      },
      stop: async () => {
        try {
          await this.#request({ method: "pane.close", params: { pane_id: paneId } });
        } catch {
          // Pane already exited or the owning Herdr server stopped.
        }
      },
    };
  }

  #request(request: { method: string; params: Record<string, unknown> }): Promise<unknown> {
    const socketPath = this.environment.HERDR_SOCKET_PATH;
    if (!socketPath) return Promise.reject(new Error("Herdr transport requires HERDR_SOCKET_PATH"));
    const payload = JSON.stringify({ id: `pi-fabric:${randomUUID()}`, ...request });
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpointFor(socketPath));
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(
        () => finish(new Error(`Herdr API request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      timeout.unref?.();
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${payload}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as HerdrErrorResponse;
          finish(responseError(response), response);
        } catch (error) {
          finish(
            new Error(
              `Invalid Herdr API response: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new Error("Herdr API closed without a response")));
    });
  }
}
