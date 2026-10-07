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
  validateTransitions,
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
    matrixRow: "ROW-1",
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
    expect(rules([base({ expected: [{ observable: "http.status", value: 200 }] })])).toContain("expected");
    expect(rules([base({ expected: [{ observable: "HTTP status", value: 200 }] })]).length).toBeGreaterThan(0);
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
    expect(rules([base({ domain: "money", matrixRow: undefined })])).toContain("matrix");
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
      // bare tokens reach the "expected" rule; spaced spellings are refused earlier by the token schema
      expect(rules([base({ expected: [{ observable: o, value: 200 }] })]).length).toBeGreaterThan(0);
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

describe("review round 2 (Codex seat, PR #500): failing-first regressions", () => {
  test("C1: ruling text cannot ride in a ruling ref, actor, source, invariant or glob field", () => {
    const b = base();
    expect(rules([{ ...b, rulings: [{ ...b.rulings[0], text: "full owner ruling" }] } as never])).toContain("schema");
    expect(rules([{ ...b, steps: [{ ...b.steps![0], actor: { ...b.steps![0].actor, note: "x" } }] } as never])).toContain("schema");
    expect(rules([{ ...b, source: { ...b.source, note: "x" } } as never])).toContain("schema");
    expect(rules([{ ...b, source: { ...b.source, runId: "the owner ruled that the dealership pays Ahmed 5,000" } } as never])).toContain("schema");
    expect(rules([{ ...b, invariantIds: ["a long free text sentence that is not an invariant id at all"] } as never])).toContain("schema");
    expect(rules([{ ...b, rulings: [{ id: RULING, digest: "not-a-digest" }] } as never])).toContain("schema");
    expect(rules([{ ...b, sourceGlobs: ["a free text sentence with spaces"] } as never])).toContain("schema");
    expect(rules([{ ...b, sourceGlobs: ["convex/**/*.ts"], invariantIds: ["ECON-1"] } as never])).toEqual([]);
  });

  test("C2: only files a configured runner collects count as the executable check", () => {
    const run = (file: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
      try {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), `test("named case", () => {});`);
        return validateLibrary([base({ impl: { file, testName: "named case" }, ...(file.startsWith("playwright/") ? { domain: "screen" as const, level: "browser" as const, matrixRow: undefined } : {}) })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(run("scripts/example.spec.ts")).toContain("impl");
    expect(run("scripts/example.test.mjs")).toContain("impl");
    expect(run("playwright/scenarios/example.spec.ts")).toEqual([]);
    expect(run("convex/example.test.ts")).toEqual([]);
  });

  test("C3: an active scenario cannot be demoted or deleted between base and head", () => {
    const active = base();
    const demoted = base({ status: "candidate", impl: undefined, candidateReason: "parked", candidateIssue: "SCRUM-770" });
    expect(validateTransitions([active], [demoted]).map((p) => p.rule)).toContain("transition");
    expect(validateTransitions([active], []).map((p) => p.rule)).toContain("transition");
    const retired = base({ status: "retired", retiredReason: "superseded", retiredByRuling: RULING });
    expect(validateTransitions([active], [retired])).toEqual([]);
    expect(validateTransitions([demoted], [active])).toEqual([]);
  });
});
describe("review round 3 (Opus closure, PR #500): failing-first regressions", () => {
  const withBody = (body: string, file = "x.test.ts", repoFile = file) => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
      return validateLibrary([base({ impl: { file: repoFile, testName: "named case" }, ...(repoFile.startsWith("playwright/") ? { domain: "screen" as const, level: "browser" as const, matrixRow: undefined } : {}) })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("R1: options-object and Playwright skip forms are not an executable check", () => {
    expect(withBody(`test("named case", { fails: true }, () => {});`)).toContain("skip");
    expect(withBody(`test("named case", { skip: true }, () => {});`)).toContain("skip");
    expect(withBody(`test("named case", { todo: true });`)).toContain("skip");
    expect(withBody(`test.fixme("named case", async () => {});`, "playwright/scenarios/a.spec.ts")).toContain("skip");
    expect(withBody(`test.describe.skip("g", () => { test("named case", async () => {}); });`, "playwright/scenarios/a.spec.ts")).toContain("skip");
    expect(withBody(`test("named case", async ({ page }) => { test.skip(true, "later"); });`, "playwright/scenarios/a.spec.ts")).toContain("skip");
    expect(withBody(`test("named case", { timeout: 5000 }, () => {});`)).toEqual([]);
  });

  test("R4: a test nested in test.describe is an active check; a lone wrapper-named one is not a pass", () => {
    expect(withBody(`test.describe("group", () => { test("named case", async () => {}); });`, "playwright/scenarios/a.spec.ts")).toEqual([]);
    expect(withBody(`test.describe("named case", () => {});`, "playwright/scenarios/a.spec.ts")).toContain("skip");
  });

  test("R3: the runner check uses the normalised path, not the spelling", () => {
    expect(withBody(`test("named case", () => {});`, "apps/mobile/x.test.ts", "scripts/../apps/mobile/x.test.ts")).toContain("impl");
    expect(withBody(`test("named case", () => {});`, "playwright/fixtures/x.spec.ts")).toContain("impl");
    expect(withBody(`test("named case", () => {});`, "build/x.test.ts")).toContain("impl");
    expect(withBody(`test("named case", () => {});`, "playwright/tests/x.spec.ts")).toEqual([]);
  });

  test("R2: metadata formats are checked whatever the status", () => {
    expect(rules([base({ domain: "money", matrixRow: "a b c; free text" })])).toContain("schema");
    expect(rules([base({ candidateIssue: "not a key" })])).toContain("schema");
    expect(rules([base({ retiredByRuling: "free text" })])).toContain("schema");
    expect(rules([base({ impl: { file: "x".repeat(400), testName: "named case" } })])).toContain("schema");
    expect(rules([base({ impl: { file: IMPL.file, testName: "t".repeat(400) } })])).toContain("schema");
    expect(rules([base({ domain: "money", matrixRow: "ROW-1" })])).toEqual([]);
  });

  test("L1/L2/L3: code-point order, malformed ruling snapshot and runId", () => {
    const upper = base({ expected: [{ observable: "a", value: 1 }, { observable: "B", value: 1 }] });
    const lower = base({ expected: [{ observable: "B", value: 1 }, { observable: "a", value: 1 }] });
    expect(scenarioFingerprint(upper)).toBe(scenarioFingerprint(lower));
    expect(() => validateRulingSnapshot([null, 5, "x"] as never)).not.toThrow();
    expect(() => validateTransitions([null as never, base()], [undefined as never])).not.toThrow();
    const noRun = base();
    delete (noRun.source as Partial<typeof noRun.source>).runId;
    expect(rules([noRun])).toContain("schema");
  });
});

describe("review round 4 (Codex seat, PR #500): failing-first regressions", () => {
  const withFile = (body: string, file: string, over: Partial<ScenarioRecord>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
      return validateLibrary([base({ impl: { file, testName: "named case" }, ...over })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("F1: an empty or parameterized named test is not a check that runs", () => {
    expect(withFile(`test.each([])("named case", () => {});`, "x.test.ts", {})).toContain("skip");
    expect(withFile(`describe.each([[1]])("g", () => { test("named case", () => {}); });`, "x.test.ts", {})).toContain("skip");
    expect(withFile(`test("named case", () => {});`, "x.test.ts", {})).toEqual([]);
  });

  test("F2: the named check must run at the record's declared level", () => {
    const spec = `test("named case", async () => {});`;
    expect(rules([base({ domain: "screen", level: "browser", matrixRow: undefined })])).toContain("impl");
    expect(withFile(spec, "playwright/scenarios/a.spec.ts", { domain: "screen", level: "browser", matrixRow: undefined })).toEqual([]);
    expect(withFile(spec, "playwright/scenarios/a.spec.ts", { level: "backend" })).toContain("impl");
  });

  test("F3: prose in action, observable or input values is refused", () => {
    const step = (action: string, input: Record<string, unknown>) => [{ actor: { role: "sales", org: "A" }, action, input }];
    expect(rules([base({ steps: step("Ahmed paid 5000 at King Street 25", {}) })])).toContain("schema");
    expect(rules([base({ steps: step("deals.approve", { note: "Ahmed from King Street" }) })])).toContain("schema");
    expect(rules([base({ expected: [{ observable: "the customer Ahmed owes money", value: 1 }] })])).toContain("schema");
    expect(rules([base({ expected: [{ observable: "deal.status", value: "free text about a customer" }] })])).toContain("schema");
    expect(rules([base({ steps: step("deals.approve", { amount: 12000, method: "cheque", at: "2026-10-07T10:00:00Z" }) })])).toEqual([]);
  });

  test("F4: leading-zero identifiers stay distinct; amounts still equate", () => {
    const withRef = (ref: string) => base({ steps: [{ actor: { role: "sales", org: "A" }, action: "x", input: { chequeNumber: ref } }] });
    expect(scenarioFingerprint(withRef("000123"))).not.toBe(scenarioFingerprint(withRef("123")));
    expect(scenarioFingerprint(withRef("12000"))).toBe(scenarioFingerprint(base({ steps: [{ actor: { role: "sales", org: "A" }, action: "x", input: { chequeNumber: 12000 } }] })));
  });

  test("F5: a permission or tenancy scenario also needs a matrix row", () => {
    expect(rules([base({ matrixRow: undefined })])).toContain("matrix");
    expect(rules([base({ domain: "tenancy", matrixRow: undefined })])).toContain("matrix");
    expect(rules([base({ domain: "screen", level: "browser", matrixRow: undefined, impl: undefined })])).not.toContain("matrix");
  });

  test("F6: malformed snapshot entries and non-string reasons are reported, not thrown", () => {
    expect(() => validateLibrary([base()], { rulings: [null as never, 5 as never], repoRoot: REPO_ROOT })).not.toThrow();
    const out = () => validateLibrary([base({ status: "retired", retiredReason: 42 as never, retiredByRuling: RULING })], { rulings: RULINGS, repoRoot: REPO_ROOT });
    expect(out).not.toThrow();
    expect(out().map((p) => p.rule)).toContain("schema");
    expect(() => validateLibrary([base({ status: "candidate", candidateReason: {} as never, candidateIssue: "SCRUM-1" })], { rulings: RULINGS, repoRoot: REPO_ROOT })).not.toThrow();
  });
});
describe("review round 5 (Opus closure #2, PR #500): failing-first regressions", () => {
  const run = (body: string, over: Partial<ScenarioRecord> = {}, file = "x.test.ts") => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
      return validateLibrary([base({ impl: { file, testName: "named case" }, ...over })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("M1: more skip / expected-failure spellings are refused (static check is best-effort; S3 census is the proof)", () => {
    for (const body of [
      `test("named case", { timeout: 5000, skip: true }, () => {});`,
      `const skip = true; test("named case", { skip }, () => {});`,
      `test("named case", { "skip": true }, () => {});`,
      `test("named case", ({ skip }) => { skip(); });`,
      `test("named case", (c) => { c.skip(); });`,
      `test("named case", async ({ page }, testInfo) => { testInfo.skip(); });`,
      `test("named case", async () => { test.fail(); });`,
      `test("named case", async () => { test.info().skip(); });`,
      `test.only("named case", () => {});`,
    ]) expect(run(body)).toContain("skip");
    expect(run(`test("named case", { timeout: 5000 }, () => {});`)).toEqual([]);
  });

  test("M2: an active cloud record cannot be certified until a cloud runner exists", () => {
    expect(rules([base({ level: "cloud" })])).toContain("level");
    expect(rules([base({ level: "cloud", status: "candidate", impl: undefined, candidateReason: "no runner yet", candidateIssue: "SCRUM-762" })])).toEqual([]);
  });

  test("M3: prose keys and prose impl fields are refused whatever the status", () => {
    const keyed = { "customer Ahmed Ali 25 King Street owes 5,000 JOD": true };
    expect(rules([base({ steps: [{ actor: { role: "sales", org: "A" }, action: "deals.approve", input: keyed }] })])).toContain("schema");
    expect(rules([base({ status: "candidate", candidateReason: "x", candidateIssue: "SCRUM-770", impl: { file: "customer Ahmed Ali 25 King Street.test.ts", testName: "x" } })])).toContain("schema");
  });

  test("M4: a blank or shared testName cannot bind records to one check", () => {
    expect(rules([base({ impl: { file: IMPL.file, testName: " " } })])).toContain("impl");
    const a = base({ id: "scn-a", steps: [{ actor: { role: "sales", org: "A" }, action: "a.one", input: {} }] });
    const b = base({ id: "scn-b", steps: [{ actor: { role: "sales", org: "A" }, action: "b.two", input: {} }] });
    expect(rules([a, b])).toContain("impl");
  });
});
describe("review round 6 (Codex closure, PR #500): failing-first regressions", () => {
  const run = (body: string, testName = "named case", over: Partial<ScenarioRecord> = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), "regression-"));
    try {
      writeFileSync(path.join(dir, "x.test.ts"), body);
      return validateLibrary([base({ impl: { file: "x.test.ts", testName }, ...over })], { rulings: RULINGS, repoRoot: dir }).map((p) => p.rule);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("SR-1: the binding is the exact registered title, not a substring", () => {
    expect(run(`test("named case here", () => {});`, "case here")).toContain("skip");
    expect(run(`test("named case", () => {});`, "named case")).toEqual([]);
  });

  test("SR-2: an unrelated .fail()/.only() on a non-runner receiver is not a skip", () => {
    expect(run(`test("named case", () => { expect(result.fail()).toBe(false); });`)).toEqual([]);
    expect(run(`test("named case", () => { expect(flags.only(3)).toBe(3); });`)).toEqual([]);
    expect(run(`test("named case", async () => { test.fail(); });`)).toContain("skip");
    expect(run(`test.only("named case", () => {});`)).toContain("skip");
  });
});
describe("kind: rule (pure-function checks, SCRUM-761 S1.5)", () => {
  function rule(over: Partial<ScenarioRecord> = {}): ScenarioRecord {
    const r: ScenarioRecord = {
      id: "sale-economics-financed-direct",
      fingerprint: "",
      domain: "money",
      level: "backend",
      status: "active",
      kind: "rule",
      source: { hunter: "scripted", runId: "run-1", firstSeen: "2026-10-07" },
      subject: "saleEconomics",
      inputs: { salePrice: 100000, externallyFinanced: true, recordedSupplierGrossReceipt: 0 },
      expected: [{ observable: "economics.dealershipMargin", value: null }],
      rulings: [{ id: RULING, digest: DIGEST }],
      impl: IMPL,
      matrixRow: "ROW-2",
      ...over,
    };
    r.fingerprint = over.fingerprint ?? scenarioFingerprint(r);
    return r;
  }

  test("a well-formed rule passes without any actor or steps", () => {
    expect(rules([rule()])).toEqual([]);
  });

  test("a rule may not carry steps, and a scenario may not carry subject/inputs", () => {
    const withSteps = rule({ steps: [{ actor: { role: "owner", org: "A" }, action: "x.y", input: {} }] });
    expect(rules([withSteps])).toContain("schema");
    const scenarioWithSubject = base({ subject: "saleEconomics" });
    expect(rules([scenarioWithSubject])).toContain("schema");
  });

  test("a rule needs a dotted-token subject and token-only inputs (no prose)", () => {
    expect(rules([rule({ subject: "sale economics" })])).toContain("schema");
    expect(rules([rule({ subject: undefined })])).toContain("schema");
    expect(rules([rule({ inputs: undefined })])).toContain("schema");
    expect(rules([rule({ inputs: { note: "the customer paid in full late" } })])).toContain("schema");
  });

  test("an unknown kind is refused", () => {
    expect(rules([rule({ kind: "other" as never })])).toContain("schema");
  });

  test("a rule is backend level and non-screen", () => {
    expect(rules([rule({ level: "browser" })])).toContain("level");
    expect(rules([rule({ domain: "screen" })])).toContain("level");
  });

  test("a rule still needs a matrix row, a ruling and an exact bound test", () => {
    expect(rules([rule({ matrixRow: undefined })])).toContain("matrix");
    expect(rules([rule({ rulings: [] })])).toContain("schema");
    expect(rules([rule({ impl: { ...IMPL, testName: "no such test" } })])).toContain("skip");
  });

  test("identity is subject + inputs: same rule de-dups, different inputs do not, and a scenario never collides with a rule", () => {
    const a = rule();
    expect(rules([a, rule({ id: "sale-economics-copy" })])).toContain("duplicate");
    const other = rule({ id: "sale-economics-other", inputs: { salePrice: 100001, externallyFinanced: true, recordedSupplierGrossReceipt: 0 }, impl: { ...IMPL, testName: "second fixture check runs" } });
    expect(scenarioFingerprint(a)).not.toBe(scenarioFingerprint(other));
    expect(scenarioFingerprint(a)).not.toBe(scenarioFingerprint(base()));
  });

  test("existing scenario fingerprints are unchanged by the rule kind", () => {
    const s = base();
    expect(scenarioFingerprint({ domain: s.domain, steps: s.steps, expected: s.expected })).toBe(s.fingerprint);
  });
});
