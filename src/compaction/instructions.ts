import { canonicalizeText, omissionLine, sampleAddressed } from "./bounds.js";

export const FABRIC_COMPACTION_REQUEST_PREFIX = "__pi_fabric_compact_request_v1__:";
const MAX_PRESERVE_ITEMS = 16;

export interface TypedCompactionRequest {
  version: 1;
  instructions?: string;
  preserve?: string[];
}

export interface CompactionInstructionPolicy {
  mode: "none" | "plain" | "typed-v1" | "malformed-typed-prefix";
  canonicalized: boolean;
  sourceBytes: number;
  truncated: boolean;
  preserveCount: number;
  omittedPreserveCount: number;
}

export interface DecodedCompactionInstructions {
  requestLines: string[];
  policy: CompactionInstructionPolicy;
}

const isTypedRequest = (value: unknown): value is TypedCompactionRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== "version" && key !== "instructions" && key !== "preserve")) return false;
  if (candidate.version !== 1) return false;
  if (candidate.instructions !== undefined && typeof candidate.instructions !== "string") return false;
  if (candidate.preserve !== undefined) {
    if (!Array.isArray(candidate.preserve) || !candidate.preserve.every((item) => typeof item === "string")) {
      return false;
    }
  }
  return true;
};

export const encodeCompactionRequest = (request: Omit<TypedCompactionRequest, "version">): string => {
  const payload: TypedCompactionRequest = {
    version: 1,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    ...(request.preserve !== undefined ? { preserve: request.preserve } : {}),
  };
  return `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify(payload)}`;
};

const plainInstructions = (
  source: string,
  mode: CompactionInstructionPolicy["mode"],
): DecodedCompactionInstructions => {
  const canonical = canonicalizeText(source);
  return {
    requestLines: canonical.text ? [canonical.text] : [],
    policy: {
      mode,
      canonicalized: canonical.text !== source,
      sourceBytes: canonical.sourceBytes,
      truncated: canonical.truncated,
      preserveCount: 0,
      omittedPreserveCount: 0,
    },
  };
};

export const decodeCompactionInstructions = (
  source: string | undefined,
): DecodedCompactionInstructions => {
  if (source === undefined || source === "") {
    return {
      requestLines: [],
      policy: {
        mode: "none",
        canonicalized: false,
        sourceBytes: 0,
        truncated: false,
        preserveCount: 0,
        omittedPreserveCount: 0,
      },
    };
  }
  if (!source.startsWith(FABRIC_COMPACTION_REQUEST_PREFIX)) {
    return plainInstructions(source, "plain");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(FABRIC_COMPACTION_REQUEST_PREFIX.length));
  } catch {
    return plainInstructions(source, "malformed-typed-prefix");
  }
  if (!isTypedRequest(parsed)) return plainInstructions(source, "malformed-typed-prefix");

  const requestLines: string[] = [];
  let sourceBytes = 0;
  let truncated = false;
  let canonicalized = false;
  if (parsed.instructions !== undefined) {
    const instructions = canonicalizeText(parsed.instructions);
    sourceBytes += instructions.sourceBytes;
    truncated ||= instructions.truncated;
    canonicalized ||= instructions.text !== parsed.instructions;
    if (instructions.text) requestLines.push(instructions.text);
  }

  const preserve = (parsed.preserve ?? []).map((item, index) => {
    const canonical = canonicalizeText(item);
    sourceBytes += canonical.sourceBytes;
    truncated ||= canonical.truncated;
    canonicalized ||= canonical.text !== item;
    return { entryId: `preserve:${index}`, text: canonical.text };
  }).filter((item) => item.text !== "");
  const sampled = sampleAddressed(preserve, MAX_PRESERVE_ITEMS);
  for (let index = 0; index < sampled.values.length; index++) {
    if (sampled.omitted > 0 && index === sampled.splitIndex) {
      requestLines.push(omissionLine(
        sampled.omitted,
        sampled.omittedFirstEntryId,
        sampled.omittedLastEntryId,
        "preserve items",
      ));
    }
    const item = sampled.values[index]!;
    requestLines.push(`- ${item.text} [${item.entryId}]`);
  }

  return {
    requestLines,
    policy: {
      mode: "typed-v1",
      canonicalized,
      sourceBytes,
      truncated,
      preserveCount: preserve.length,
      omittedPreserveCount: sampled.omitted,
    },
  };
};
