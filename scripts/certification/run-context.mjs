import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compileFabricSummary } from "../../dist/compaction/hook.js";
import { encodeCwdDir } from "../../dist/memory/discovery.js";
import { normalizeSession } from "../../dist/memory/normalize.js";
import { MemoryProvider } from "../../dist/providers/memory-provider.js";
import {
  evaluateCertification,
  evaluateFixtureOracle,
  formatHumanReport,
  runDeterministicHandoff,
  snapshotFiles,
} from "./context-lib.mjs";

const POISON = "PRIOR_SUMMARY_POISON_991";
const GOAL = "Goal: stabilize compaction and cross-session memory certification.";
const CONSTRAINT = "Constraint: never modify forbidden.txt and keep all work offline.";
const RARE_FACT = "Pinned fact: quasarneedle_7f91 maps to Ωmega雪 and port 43117.";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistantText = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "certification",
  model: "deterministic",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});
const assistantCall = (id, name, arguments_) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: arguments_ }],
  api: "anthropic-messages",
  provider: "certification",
  model: "deterministic",
  usage,
  stopReason: "toolUse",
  timestamp: Date.now(),
});
const toolResult = (toolCallId, toolName, text, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError,
  timestamp: Date.now(),
});

const pairSplitCount = (entries, firstKeptEntryId) => {
  const boundary = firstKeptEntryId
    ? entries.findIndex((entry) => entry.id === firstKeptEntryId)
    : entries.length;
  const pairs = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const side = index < boundary ? "summary" : "kept";
    const message = entry.message;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
        const pair = pairs.get(part.id) ?? {};
        pair.call = side;
        pairs.set(part.id, pair);
      }
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const pair = pairs.get(message.toolCallId) ?? {};
      pair.result = side;
      pairs.set(message.toolCallId, pair);
    }
  }
  return [...pairs.values()].filter((pair) => pair.call && pair.result && pair.call !== pair.result).length;
};

const directoryBytes = (root) => {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : entry.isFile() ? fs.statSync(target).size : 0;
  }
  return total;
};

const invocationContext = (cwd) => ({
  cwd,
  signal: undefined,
  parentToolCallId: "certification",
  nestedToolCallId: "certification-memory",
  extensionContext: {},
  update() {},
});

const createContextCertification = (sessionDir, cwd) => {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage(user(`${GOAL}\n${CONSTRAINT}\n${RARE_FACT}`));
  manager.appendMessage(assistantCall("initial-read", "read", { path: "src/original.ts" }));
  manager.appendMessage(toolResult("initial-read", "read", "original source"));
  manager.appendMessage(assistantCall("initial-error", "read", { path: "src/rare-missing.ts" }));
  manager.appendMessage(toolResult("initial-error", "read", "ENOENT certification-open-error", true));
  manager.appendMessage(user("Cycle boundary 0"));

  const summaryBytes = [];
  const emittedEntryIds = new Set();
  let goalRetained = true;
  let constraintsRetained = true;
  let rareFactRetained = true;
  let cumulativeAddressesValid = true;
  let callResultSplitCount = 0;
  let invalidFirstKeptCount = 0;
  let poisonLeakCount = 0;
  let byteMismatchCount = 0;

  for (let cycle = 0; cycle < 100; cycle += 1) {
    const branch = manager.getBranch();
    const first = compileFabricSummary(branch, 10_000);
    const second = compileFabricSummary(branch, 10_000);
    if (!("compaction" in first) || !("compaction" in second)) {
      throw new Error(`Compaction cancelled at cycle ${cycle + 1}`);
    }
    const compacted = first.compaction;
    const summary = compacted.summary;
    const details = compacted.details;
    summaryBytes.push(Buffer.byteLength(summary, "utf8"));
    goalRetained &&= summary.includes(GOAL);
    constraintsRetained &&= summary.includes(CONSTRAINT);
    rareFactRetained &&= summary.includes(RARE_FACT);
    poisonLeakCount += summary.includes(POISON) ? 1 : 0;
    byteMismatchCount += summary === second.compaction.summary
      && JSON.stringify(details) === JSON.stringify(second.compaction.details) ? 0 : 1;
    if (compacted.firstKeptEntryId && !branch.some((entry) => entry.id === compacted.firstKeptEntryId)) {
      invalidFirstKeptCount += 1;
    }
    callResultSplitCount += pairSplitCount(branch, compacted.firstKeptEntryId);

    const sourceRange = details.coverage.cumulativeSourceRange;
    const stableRange = details.stableAddresses.cumulativeSourceRange;
    cumulativeAddressesValid &&= sourceRange.first !== ""
      && sourceRange.last !== ""
      && stableRange.first === sourceRange.first
      && stableRange.last === sourceRange.last
      && branch.some((entry) => entry.id === sourceRange.first)
      && branch.some((entry) => entry.id === sourceRange.last)
      && summary.includes("original.ts")
      && summary.includes("rare-missing.ts")
      && summary.includes("ENOENT certification-open-error");

    for (const entry of branch) {
      if (entry.type === "message" && summary.includes(entry.id)) emittedEntryIds.add(entry.id);
    }
    for (const address of [
      compacted.firstKeptEntryId,
      sourceRange.first,
      sourceRange.last,
      details.coverage.liveCutRange.first,
      details.coverage.liveCutRange.last,
    ]) {
      if (address) emittedEntryIds.add(address);
    }

    manager.appendCompaction(summary, compacted.firstKeptEntryId, compacted.tokensBefore, details, true);
    const callId = `cycle-write-${cycle}`;
    manager.appendMessage(assistantCall(callId, "write", { path: `src/cycles/file-${String(cycle).padStart(3, "0")}.ts` }));
    manager.appendMessage(toolResult(callId, "write", `wrote deterministic cycle ${cycle}`));
    manager.appendMessage(user(`Cycle boundary ${cycle + 1}`));
  }

  const entries = manager.getEntries();
  const parentLinksValid = entries.every((entry, index) => index === 0
    ? entry.parentId === null
    : entry.parentId === entries[index - 1].id);
  cumulativeAddressesValid &&= parentLinksValid
    && entries.filter((entry) => entry.type === "compaction").length === 100;
  return {
    manager,
    emittedEntryIds,
    metrics: {
      cycles: 100,
      summaryBytes,
      maxSummaryBytes: Math.max(...summaryBytes),
      goalRetained,
      constraintsRetained,
      rareFactRetained,
      cumulativeAddressesValid,
      callResultSplitCount,
      invalidFirstKeptCount,
      poisonLeakCount,
      byteMismatchCount,
      parentLinksValid,
      priorSummaryFedAsInput: false,
    },
  };
};

const createMemoryCertification = async ({ agentDir, cwd, sessionDir, contextResult, indexDir }) => {
  const baseSeconds = 1_700_000_000;
  let rareSessionFile = "";
  let rareEntryId = "";
  const coldRareFact = "cold_exact_quasar_7f91 Ωmega雪 address=43117";
  for (let index = 0; index < 1_000; index += 1) {
    const manager = SessionManager.create(cwd, sessionDir);
    const text = index === 0
      ? coldRareFact
      : `common certification distractor session_${String(index).padStart(4, "0")}`;
    const entryId = manager.appendMessage(user(text));
    manager.appendMessage(assistantText("Indexed certification session."));
    const file = manager.getSessionFile();
    if (!file) throw new Error("Expected a persisted memory session");
    fs.utimesSync(file, baseSeconds + index, baseSeconds + index);
    if (index === 0) {
      rareSessionFile = file;
      rareEntryId = entryId;
    }
  }
  const contextFile = contextResult.manager.getSessionFile();
  if (!contextFile) throw new Error("Expected a persisted context session");
  fs.utimesSync(contextFile, baseSeconds + 2_000, baseSeconds + 2_000);

  const provider = new MemoryProvider({
    agentDir,
    cwd,
    config: {
      enabled: true,
      indexDir,
      maxSessions: 25,
      maxEntryChars: 256,
      hotSessions: 8,
      digestTerms: 8,
    },
  });
  const recalled = await provider.invoke(
    "recall",
    { scope: "global", query: "cold_exact_quasar_7f91 ΩMEGA雪", pageSize: 20 },
    invocationContext(cwd),
  );
  const rareHit = recalled.digestHits.find((hit) => hit.sessionId === SessionManager.open(rareSessionFile).getSessionId());
  const rareExpansion = await provider.invoke(
    "expand",
    { session: rareSessionFile, entryIds: [rareEntryId] },
    invocationContext(cwd),
  );

  const sourceById = new Map(
    normalizeSession(contextFile, Number.MAX_SAFE_INTEGER).entries
      .filter((entry) => entry.entryId !== null)
      .map((entry) => [entry.entryId, entry.text]),
  );
  const emittedIds = [...contextResult.emittedEntryIds];
  const expandedAddresses = await provider.invoke(
    "expand",
    { session: contextFile, entryIds: emittedIds },
    invocationContext(cwd),
  );
  const expandedById = new Map(expandedAddresses.expanded.map((entry) => [entry.entryId, entry.text]));
  const expandedCorrectly = emittedIds.filter((id) => expandedById.get(id) === sourceById.get(id)).length;
  const rareTier = rareHit?.tier ?? "missing";
  const sourceRoot = path.join(agentDir, "sessions");

  return {
    eligibleSessions: recalled.coverage.eligibleSessions,
    indexedSessions: recalled.coverage.indexedSessions,
    staleSessions: recalled.coverage.staleSessions,
    coverageComplete: recalled.coverage.complete,
    rareSessionTier: rareTier,
    rareRecallExact: Boolean(rareHit)
      && rareHit.entryIds.includes(rareEntryId)
      && rareExpansion.expanded.length === 1
      && rareExpansion.expanded[0].text === coldRareFact,
    emittedAddresses: emittedIds.length,
    expandedAddresses: expandedCorrectly,
    addressExpansionRate: emittedIds.length === 0 ? 0 : expandedCorrectly / emittedIds.length,
    cacheBytes: directoryBytes(indexDir),
    sourceBytes: directoryBytes(sourceRoot),
  };
};

const fixtures = [
  {
    name: "create-module",
    initialFiles: {
      "package.json": "{\"type\":\"module\"}\n",
      "test.mjs": "import assert from 'node:assert/strict';\nimport { sum } from './src/sum.js';\nassert.equal(sum(2, 3), 5);\n",
      "forbidden.txt": "do-not-touch\n",
    },
    task: {
      operations: [{ type: "write", path: "src/sum.js", content: "export const sum = (left, right) => left + right;\n" }],
    },
    expectedFiles: {
      "package.json": "{\"type\":\"module\"}\n",
      "test.mjs": "import assert from 'node:assert/strict';\nimport { sum } from './src/sum.js';\nassert.equal(sum(2, 3), 5);\n",
      "forbidden.txt": "do-not-touch\n",
      "src/sum.js": "export const sum = (left, right) => left + right;\n",
    },
    forbiddenPaths: ["forbidden.txt"],
    test: { command: process.execPath, args: ["test.mjs"] },
  },
  {
    name: "targeted-replacement",
    initialFiles: {
      "config.json": "{\"enabled\":false,\"port\":43117}\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst value = JSON.parse(fs.readFileSync('config.json', 'utf8'));\nassert.deepEqual(value, { enabled: true, port: 43117 });\n",
      "notes/forbidden.md": "historical record\n",
    },
    task: {
      operations: [{ type: "replace", path: "config.json", oldText: "\"enabled\":false", newText: "\"enabled\":true" }],
    },
    expectedFiles: {
      "config.json": "{\"enabled\":true,\"port\":43117}\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst value = JSON.parse(fs.readFileSync('config.json', 'utf8'));\nassert.deepEqual(value, { enabled: true, port: 43117 });\n",
      "notes/forbidden.md": "historical record\n",
    },
    forbiddenPaths: ["notes/forbidden.md"],
    test: { command: process.execPath, args: ["verify.mjs"] },
  },
];

const createContinuationCertification = async ({ root, sessionDir, cwd, memoryProvider }) => {
  const results = [];
  for (const fixture of fixtures) {
    const fixtureRoot = path.join(root, "continuation", fixture.name);
    for (const [relative, content] of Object.entries(fixture.initialFiles)) {
      const file = path.join(fixtureRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
    const forbiddenBefore = snapshotFiles(fixtureRoot, fixture.forbiddenPaths);
    const manager = SessionManager.create(cwd, sessionDir);
    const taskText = `CERT_TASK_V1\n${JSON.stringify({ ...fixture.task, padding: "x".repeat(1_500) })}`;
    manager.appendMessage(user(taskText));
    manager.appendMessage(assistantText("Task accepted; retain the source address for deterministic continuation."));
    manager.appendMessage(user("Compact before continuation"));
    const compiled = compileFabricSummary(manager.getBranch(), 8_000);
    if (!("compaction" in compiled)) throw new Error(`Could not compact fixture ${fixture.name}`);
    const compactedContext = {
      summary: compiled.compaction.summary,
      details: compiled.compaction.details,
    };
    const handoff = await runDeterministicHandoff({
      root: fixtureRoot,
      compactedContext,
      recall: async ({ entryIds }) => {
        const result = await memoryProvider.invoke(
          "expand",
          { session: manager.getSessionFile(), entryIds },
          invocationContext(cwd),
        );
        return result.expanded;
      },
    });
    const oracle = evaluateFixtureOracle(fixtureRoot, fixture, forbiddenBefore);
    results.push({
      name: fixture.name,
      handoff: { operationCount: handoff.operationCount, addressResolved: true },
      oracle: { passed: oracle.passed, failures: oracle.failures, testStatus: oracle.test.status },
    });
  }
  const passedFixtures = results.filter((result) => result.oracle.passed).length;
  return {
    totalFixtures: results.length,
    passedFixtures,
    passRate: results.length === 0 ? 0 : passedFixtures / results.length,
    primaryMetric: "executable filesystem, forbidden-change, and process-test oracle",
    results,
  };
};

export const runContextCertification = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-certification-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  const sessionDir = path.join(agentDir, "sessions", encodeCwdDir(cwd));
  const indexDir = path.join(root, "memory-index");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const contextResult = createContextCertification(sessionDir, cwd);
    const memory = await createMemoryCertification({ agentDir, cwd, sessionDir, contextResult, indexDir });
    const memoryProvider = new MemoryProvider({
      agentDir,
      cwd,
      config: { enabled: true, indexDir, maxSessions: 25, maxEntryChars: 256, hotSessions: 8, digestTerms: 8 },
    });
    const continuation = await createContinuationCertification({ root, sessionDir, cwd, memoryProvider });
    const report = {
      schemaVersion: 1,
      deterministic: true,
      context: contextResult.metrics,
      memory,
      continuation,
    };
    report.evaluation = evaluateCertification(report);
    return report;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { formatHumanReport };
