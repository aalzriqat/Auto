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
const IMPL = { file: "scripts/regression/implFixture.test.ts", testName: "fixture check runs" };

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
    const b = base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { id: "b".repeat(32), at: "2026-10-07T11:30:00Z", ref: "deal-1744000000" } }] });
    const c = base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { id: "b".repeat(32), at: "2026-10-07T11:30:00Z", ref: "deal-1744000000", amount: 1 } }] });
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
    expect(rules([base({ rulings: [] })])).toContain("schema");
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
    expect(rules([base({ status: "retired", retiredByRuling: RULING })])).toContain("retired");
    expect(rules([base({ status: "retired", retiredReason: "superseded" })])).toContain("retired");
    expect(rules([base({ status: "retired", retiredReason: "superseded", retiredByRuling: RULING })])).toEqual([]);
  });

  test("an active backend scenario must name an existing executable check", () => {
    expect(rules([base({ impl: undefined })])).toContain("impl");
    expect(rules([base({ impl: { file: "scripts/regression/missing.test.ts", testName: "x" } })])).toContain("impl");
    expect(rules([base({ impl: { file: IMPL.file, testName: "zz-not-in-file-" + "9f3" } })])).toContain("skip");
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
    const c = base({ status: "candidate", impl: undefined, candidateReason: "found by explorer", candidateIssue: "SCRUM-770" });
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

describe("review round 1 (Opus seat, PR #500): failing-first regressions", () => {
  const tmpImpl = (body: string, name = "x.test.ts") => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    writeFileSync(path.join(dir, name), body);
    return dir;
  };
  const withImpl = (body: string, testName = "named case", file = "x.test.ts") => {
    const dir = tmpImpl(body, file);
    try {
      return validateLibrary([base({ impl: { file, testName } })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("F1: skipIf/runIf/fails/ctx.skip and comment-only names do not count as an executable check", () => {
    expect(withImpl(`describe.skipIf(true)("s", () => { test("named case", () => {}); });`)).toContain("skip");
    expect(withImpl(`describe.runIf(false)("s", () => { test("named case", () => {}); });`)).toContain("skip");
    expect(withImpl(`it.skipIf(true)("named case", () => {});`)).toContain("skip");
    expect(withImpl(`test.fails("named case", () => {});`)).toContain("skip");
    expect(withImpl(`test("named case", (ctx) => { ctx.skip(); });`)).toContain("skip");
    expect(withImpl(`// named case\ntest("other", () => {});`)).toContain("skip");
    expect(withImpl(`test("named case", () => {});`)).toEqual([]);
  });

  test("F1: the impl must be a test file a runner executes, not any source file", () => {
    expect(withImpl(`export const named = "named case";`, "named case", "helper.ts")).toContain("impl");
  });

  test("F2: an active browser scenario still has to name its replay spec", () => {
    expect(rules([base({ domain: "screen", level: "browser", impl: undefined })])).toContain("impl");
  });

  test("F2: step and expectation shapes are checked", () => {
    expect(rules([base({ steps: [{} as never], expected: [{} as never] })])).toContain("schema");
  });

  test("F3: a candidate needs a reason and an issue key", () => {
    expect(rules([base({ status: "candidate", impl: undefined })])).toContain("candidate");
    expect(rules([base({ status: "candidate", impl: undefined, candidateIssue: "SCRUM-770" })])).toContain("candidate");
    expect(rules([base({ status: "candidate", impl: undefined, candidateReason: "found by explorer" })])).toContain("candidate");
    expect(rules([base({ status: "candidate", impl: undefined, candidateReason: "found by explorer", candidateIssue: "SCRUM-770" })])).toEqual([]);
  });

  test("F4: a retirement must cite a ruling that exists in the snapshot", () => {
    expect(rules([base({ status: "retired", retiredReason: "superseded", retiredByRuling: "SCRUM-1#c1" })])).toContain("retired");
  });

  test("F5: unknown fields (e.g. pasted ruling text) are refused in a record", () => {
    expect(rules([{ ...base(), rulingText: "customer Ahmed paid 5,000" } as never])).toContain("schema");
    expect(rules([base({ retiredReason: "x".repeat(400), status: "retired", retiredByRuling: RULING })])).toContain("schema");
    expect(rules([base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input: { note: "mail me at a.b@example.com" } }] })])).toContain("schema");
  });

  test("F6: numeric strings, expected order, clerk ids and boundary dates fingerprint correctly", () => {
    const withInput = (input: Record<string, unknown>) =>
      base({ steps: [{ actor: { role: "owner", org: "A" }, action: "x", input }] });
    expect(scenarioFingerprint(withInput({ amount: 12000 }))).toBe(scenarioFingerprint(withInput({ amount: "12000" })));
    expect(scenarioFingerprint(withInput({ who: "user_2abcDEF123" }))).toBe(scenarioFingerprint(withInput({ who: "user_9zzzXYZ987" })));
    expect(scenarioFingerprint(withInput({ amount: "-1500000" }))).not.toBe(scenarioFingerprint(withInput({ amount: "-2500000" })));
    expect(scenarioFingerprint(withInput({ ref: "CHQ-000123" }))).not.toBe(scenarioFingerprint(withInput({ ref: "CHQ-000124" })));
    expect(scenarioFingerprint(withInput({ at: "2026-09-30T23:59:00Z" }))).not.toBe(scenarioFingerprint(withInput({ at: "2026-10-01T00:00:00Z" })));
    const e1 = base({ expected: [{ observable: "a", value: 1 }, { observable: "b", value: 2 }] });
    const e2 = base({ expected: [{ observable: "b", value: 2 }, { observable: "a", value: 1 }] });
    expect(scenarioFingerprint(e1)).toBe(scenarioFingerprint(e2));
  });

  test("LOW: malformed records are reported, not thrown; impl cannot escape the repo; more HTTP spellings", () => {
    expect(() => validateLibrary([{} as never, null as never, base({ expected: [null as never] })], { rulings: RULINGS, repoRoot: REPO_ROOT })).not.toThrow();
    const parent = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.join(parent, "repo"));
      writeFileSync(path.join(parent, "outside.test.ts"), `test("named case", () => {});`);
      const out = validateLibrary([base({ impl: { file: "../outside.test.ts", testName: "named case" } })], { rulings: RULINGS, repoRoot: path.join(parent, "repo") });
      expect(out.map((p) => p.message).join()).toContain("inside the repository");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    for (const o of ["response.status", "res.status", "http_status", "HTTP 200"]) {
      expect(rules([base({ expected: [{ observable: o, value: 200 }] })])).toContain("expected");
    }
  });

  test("LOW: a misnamed file in the scenarios directory is refused, not silently ignored", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.join(dir, "regression", "scenarios"), { recursive: true });
      writeFileSync(path.join(dir, "regression", "rulings.json"), "[]");
      writeFileSync(path.join(dir, "regression", "scenarios", "oops.json"), "{}");
      expect(loadLibrary(dir).problems.map((p) => p.rule)).toContain("schema");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});