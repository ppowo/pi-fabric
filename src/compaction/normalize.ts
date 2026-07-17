import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// A purely structural, typed view of one session window. Every event carries
// the 1-based `index` it occupied in the normalized stream (stable, used by the
// brief-transcript `(#N)` references) and the `entryId` of the SessionEntry it
// came from (used by the footer's recall range). Normalization extracts ONLY
// typed structure — roles, tool names, JSON arguments, isError flags, bash
// commands and exit codes. It never inspects prose. See docs/compaction.md
// principle 2.

interface EventBase {
  index: number;
  entryId: string;
}

interface UserEvent extends EventBase {
  kind: "user";
  text: string;
}

interface AssistantTextEvent extends EventBase {
  kind: "assistantText";
  text: string;
}

interface ThinkingEvent extends EventBase {
  kind: "thinking";
  text: string;
}

export interface ToolCallEvent extends EventBase {
  kind: "toolCall";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultEvent extends EventBase {
  kind: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

interface BashEvent extends EventBase {
  kind: "bash";
  toolCallId: string;
  command: string;
  isError: boolean;
  exitCode: number | null;
  output: string;
}

export type CompactionEvent =
  | UserEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | BashEvent;

const isMessageEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> =>
  entry.type === "message";

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part) {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
};

const firstLine = (text: string): string => {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf("\n");
  return nl < 0 ? trimmed : trimmed.slice(0, nl);
};

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
}

type DistributiveOmit<T, K extends keyof any> = T extends T ? Omit<T, K> : never;

// Normalize a window of SessionEntries into a flat, typed event stream.
// `entries` must already be the live window to summarize (post last-compaction
// boundary, up to the cut). Tool results are paired back to their tool calls by
// id so a bash result can carry the command from the originating call; this
// pairing is structural (id match), never prose-based.
export const normalizeEntries = (entries: SessionEntry[]): CompactionEvent[] => {
  const events: CompactionEvent[] = [];
  const calls = new Map<string, PendingCall>();
  let index = 0;

  const push = (event: DistributiveOmit<CompactionEvent, "index">): void => {
    index += 1;
    events.push({ ...event, index } as CompactionEvent);
  };

  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as SessionMessageEntry["message"];
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const entryId = entry.id;

    if (role === "user") {
      push({ kind: "user", entryId, text: textOfContent((message as { content: unknown }).content) });
      continue;
    }

    if (role === "assistant") {
      const content = (message as { content: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object" || !("type" in part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          push({ kind: "assistantText", entryId, text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string") {
          push({ kind: "thinking", entryId, text: part.thinking });
        } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          const args = (part.arguments ?? {}) as Record<string, unknown>;
          calls.set(part.id, { name: part.name, args });
          push({ kind: "toolCall", entryId, toolCallId: part.id, name: part.name, args });
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const toolResult = message as {
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        content?: unknown;
      };
      const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
      const toolName = typeof toolResult.toolName === "string" ? toolResult.toolName : "";
      const isError = toolResult.isError === true;
      const text = textOfContent(toolResult.content);
      if (toolName === "bash") {
        const pending = toolCallId ? calls.get(toolCallId) : undefined;
        const command =
          pending && typeof pending.args.command === "string"
            ? pending.args.command
            : "";
        push({
          kind: "bash",
          entryId,
          toolCallId,
          command,
          isError,
          exitCode: null,
          output: text,
        });
      } else {
        push({ kind: "toolResult", entryId, toolCallId, toolName, isError, text });
      }
      continue;
    }

    if (role === "bashExecution") {
      const bash = message as {
        command?: string;
        exitCode?: number | undefined;
        output?: string;
      };
      const exitCode = typeof bash.exitCode === "number" ? bash.exitCode : null;
      push({
        kind: "bash",
        entryId,
        toolCallId: "",
        command: typeof bash.command === "string" ? bash.command : "",
        isError: exitCode !== null && exitCode !== 0,
        exitCode,
        output: typeof bash.output === "string" ? bash.output : "",
      });
      continue;
    }

    // custom / branchSummary / compactionSummary and any other roles carry no
    // raw work signal for the deterministic core and are skipped here.
  }

  return events;
};

export { firstLine };
