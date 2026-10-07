/**
 * SCRUM-761 S1: one failing case per truthfulness rule, plus the live library
 * check. Each rule is proven by a record that breaks only that rule.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  digestRulingText,
  loadLibrary,
  scenarioFingerprint,
  summariseLibrary,
  validateLibrary,
  validateRulingSnapshot,
  type RulingSnapshotEntry,
  type ScenarioRecord,
} from "./scenarioRecord";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RULING = "SCRUM-407#c21031";
const DIGEST = digestRulingText("example ruling text");
const RULINGS: RulingSnapshotEntry[] = [{ id: RULING, digest: DIGEST, date: "2026-10-07" }];
// A real file in this repo with no skipped tests that contains the named string.
const IMPL = { file: "scripts/regression/scenarioRecord.ts", testName: "validateLibrary" };

function base(over: Partial<ScenarioRecord> = {}): ScenarioRecord {
  const r: ScenarioRecord = {
    id: "fc-transfer-full-approved",
    fingerprint: "",
    domain: "permission",
    level: "backend",
    status: "active",
    source: { hunter: "scripted", runId: "run-1", firstSeen: "2026-10-07" },
    steps: [{ actor: { role: "sales", org: "A" }, action: "deals.approve", input: { amount: 12000 } }],
    expected: [{ observable: "deal.status", value: "forbidden" }],
    rulings: [{ id: RULING, digest: DIGEST }],
    impl: IMPL,
    ...over,
  };
  r.fingerprint = over.fingerprint ?? scenarioFingerprint(r);
  return r;
}

const rules = (records: ScenarioRecord[], rulings = RULINGS) =>
  validateLibrary(records, { rulings, repoRoot: REPO_ROOT }).map((p) => p.rule);

describe("scenario record validators", () => {
  test("a well-formed active scenario passes", () => {
    expect(rules([base()])).toEqual([]);
  });

  test("fingerprint ignores ids, timestamps and per-run suffixes but not amounts", () => {
    const a = base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { id: "a".repeat(32), at: "2026-10-07T10:00:00Z", ref: "deal-1733000000" } }] });
    const b = base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { id: "b".repeat(32), at: "2026-10-08T11:30:00Z", ref: "deal-1744000000" } }] });
    const c = base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { id: "b".repeat(32), at: "2026-10-08T11:30:00Z", ref: "deal-1744000000", amount: 1 } }] });
    expect(scenarioFingerprint(a)).toBe(scenarioFingerprint(b));
    expect(scenarioFingerprint(a)).not.toBe(scenarioFingerprint(c));
  });

  test("a wrong stored fingerprint is refused", () => {
    expect(rules([base({ fingerprint: "0".repeat(64) })])).toContain("fingerprint");
  });

  test("two records with the same fingerprint are refused (de-dup)", () => {
    const a = base();
    const b = base({ id: "fc-transfer-second-copy" });
    expect(rules([a, b])).toContain("duplicate");
  });

  test("a scenario with no ruling is refused", () => {
    expect(rules([base({ rulings: [] })])).toContain("ruling");
  });

  test("a ruling absent from the snapshot is refused", () => {
    expect(rules([base()], [])).toContain("ruling");
  });

  test("ruling drift: a changed digest fails until the scenario is updated", () => {
    const moved = [{ id: RULING, digest: digestRulingText("the ruling was changed"), date: "2026-10-08" }];
    expect(rules([base()], moved)).toContain("ruling-drift");
  });

  test("a bare HTTP status is not an observable", () => {
    expect(rules([base({ expected: [{ observable: "HTTP status", value: 200 }] })])).toContain("expected");
  });

  test("retired needs a reason and a ruling; red is never silently parked", () => {
    expect(rules([base({ status: "retired" })])).toContain("retired");
    expect(rules([base({ status: "retired", retiredByRuling: "SCRUM-435#c19000" })])).toContain("retired");
    expect(rules([base({ status: "retired", retiredReason: "superseded" })])).toContain("retired");
    expect(rules([base({ status: "retired", retiredReason: "superseded", retiredByRuling: "SCRUM-435#c19000" })])).toEqual([]);
  });

  test("an active backend scenario must name an existing executable check", () => {
    expect(rules([base({ impl: undefined })])).toContain("impl");
    expect(rules([base({ impl: { file: "scripts/regression/missing.test.ts", testName: "x" } })])).toContain("impl");
    expect(rules([base({ impl: { file: IMPL.file, testName: "zz-not-in-file-" + "9f3" } })])).toContain("impl");
  });

  test("a library check file containing a skipped test is refused (cannot-run = FAIL)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.join(dir, "t"));
      writeFileSync(path.join(dir, "t", "x.test.ts"), `test("named case", () => {});\nit.skip("other", () => {});\n`);
      const out = validateLibrary([base({ impl: { file: "t/x.test.ts", testName: "named case" } })], { rulings: RULINGS, repoRoot: dir });
      expect(out.map((p) => p.rule)).toContain("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a money scenario needs a SCRUM-486 matrix row", () => {
    expect(rules([base({ domain: "money" })])).toContain("matrix");
    expect(rules([base({ domain: "money", matrixRow: "M-12" })])).toEqual([]);
  });

  test("only screen scenarios may be browser replays", () => {
    expect(rules([base({ level: "browser" })])).toContain("level");
  });

  test("bugRef needs the sha where the test was red", () => {
    expect(rules([base({ bugRef: { key: "SCRUM-690", failingFirst: "abc" } })])).toContain("bug");
    expect(rules([base({ bugRef: { key: "SCRUM-690", failingFirst: "a".repeat(40) } })])).toEqual([]);
  });

  test("a candidate is reported, not executed, and is counted", () => {
    const c = base({ status: "candidate", impl: undefined });
    expect(rules([c])).toEqual([]);
    expect(summariseLibrary([c, base({ id: "other-one-here", steps: [{ actor: { role: "x", org: "A" }, action: "y", input: {} }] })]).candidatesPending).toBe(1);
  });
});

describe("ruling snapshot (public repo: ids, digests, dates only)", () => {
  test("valid entries pass", () => {
    expect(validateRulingSnapshot(RULINGS)).toEqual([]);
  });

  test("ruling text or any extra field is refused", () => {
    const leaky = [{ ...RULINGS[0], text: "customer Ahmed paid 5,000" }];
    expect(validateRulingSnapshot(leaky).map((p) => p.message).join()).toContain("forbidden field");
  });

  test("duplicate, malformed id and bad digest are refused", () => {
    expect(validateRulingSnapshot([RULINGS[0], RULINGS[0]]).map((p) => p.message).join()).toContain("duplicate");
    expect(validateRulingSnapshot([{ id: "nope", digest: "x", date: "today" }]).length).toBe(3);
    expect(validateRulingSnapshot({})[0].message).toContain("array");
  });
});

describe("the committed library", () => {
  test("loads the committed library and it has no problems", () => {
    const { records, rulings, problems } = loadLibrary(REPO_ROOT);
    expect([...problems, ...validateLibrary(records, { rulings, repoRoot: REPO_ROOT })]).toEqual([]);
  });
});
