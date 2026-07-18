import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Certification helpers are dependency-free JavaScript used directly by Node.
import { evaluateCertification, evaluateFixtureOracle, formatHumanReport, snapshotFiles } from "../../scripts/certification/context-lib.mjs";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-certification-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const passingReport = () => ({
  context: {
    cycles: 100,
    summaryBytes: Array.from({ length: 100 }, () => 8_000),
    maxSummaryBytes: 8_000,
    goalRetained: true,
    constraintsRetained: true,
    rareFactRetained: true,
    cumulativeAddressesValid: true,
    callResultSplitCount: 0,
    invalidFirstKeptCount: 0,
    poisonLeakCount: 0,
    byteMismatchCount: 0,
  },
  memory: {
    eligibleSessions: 1_001,
    indexedSessions: 1_001,
    coverageComplete: true,
    rareRecallExact: true,
    rareSessionTier: "cold",
    addressExpansionRate: 1,
    cacheBytes: 10,
    sourceBytes: 20,
  },
  continuation: { passRate: 1, passedFixtures: 2, totalFixtures: 2 },
});

describe("certification thresholds", () => {
  it("passes the documented deterministic thresholds", () => {
    const report = passingReport();
    const evaluation = evaluateCertification(report);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  });

  it("reports threshold failures and renders a failing human report", () => {
    const report = passingReport();
    report.context.maxSummaryBytes = 40_000;
    report.context.byteMismatchCount = 1;
    report.memory.addressExpansionRate = 0.99;
    report.continuation.passRate = 0.5;
    const evaluation = evaluateCertification(report);
    const complete = { ...report, evaluation };
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.filter((check: { passed: boolean }) => !check.passed).map((check: { id: string }) => check.id))
      .toEqual(expect.arrayContaining([
        "context.determinism",
        "context.size",
        "memory.addressExpansion",
        "continuation.oracle",
      ]));
    expect(formatHumanReport(complete)).toContain("Context + memory certification: FAIL");
  });
});

describe("continuation executable oracle", () => {
  it("accepts exact files, unchanged forbidden files, and a passing process test", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "result.txt"), "done\n", "utf8");
    fs.writeFileSync(path.join(root, "forbidden.txt"), "stable\n", "utf8");
    const fixture = {
      initialFiles: { "result.txt": "done\n", "forbidden.txt": "stable\n" },
      expectedFiles: { "result.txt": "done\n", "forbidden.txt": "stable\n" },
      test: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    };
    const before = snapshotFiles(root, ["forbidden.txt"]);
    expect(evaluateFixtureOracle(root, fixture, before)).toMatchObject({ passed: true, failures: [] });
  });

  it("rejects content mismatches and forbidden changes before running tests", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "result.txt"), "wrong\n", "utf8");
    fs.writeFileSync(path.join(root, "forbidden.txt"), "changed\n", "utf8");
    const fixture = {
      initialFiles: { "result.txt": "expected\n", "forbidden.txt": "stable\n" },
      expectedFiles: { "result.txt": "expected\n", "forbidden.txt": "stable\n" },
      test: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    };
    const result = evaluateFixtureOracle(root, fixture, { "forbidden.txt": "stable\n" });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "result.txt: content mismatch",
      "forbidden.txt: content mismatch",
      "forbidden.txt: forbidden change",
    ]));
    expect(result.test.status).toBeNull();
  });
});
