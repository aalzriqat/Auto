// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const load = () => import("./trustedPrE2eGate.mjs");
const identity = {
  headSha: "a".repeat(40),
  testedSha: "b".repeat(40),
  controllerSha: "c".repeat(40),
};
const report = () => ({
  errors: [],
  stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
  suites: [
    {
      specs: [0, 1].map((n) => ({
        id: String(n),
        file: "expenses.spec.ts",
        tests: [
          {
            projectName: "chromium",
            expectedStatus: "passed",
            status: "expected",
            results: [{ status: "passed" }],
          },
        ],
      })),
    },
  ],
});

describe("SCRUM-757 trusted PR scope", () => {
  it.each([
    [["README.md", "docs/architecture/gate.md"], false],
    [["components/expenses/Dialog.tsx"], true],
    [["convex/expenses.ts"], true],
    [["playwright/tests/new.spec.ts"], true],
    [[".github/workflows/playwright.yml"], true],
    [["docs/example.mdx"], true],
    [[], true],
  ])(
    "classifies %j without trusting candidate scope flags",
    async (files, inScope) => {
      expect(
        (await load()).planPrE2e(files, ["playwright/tests/expenses.spec.ts"])
          .inScope,
      ).toBe(inScope);
    },
  );

  it("records trusted definitions and candidate modifications, including deleted and renamed specs", async () => {
    const plan = (await load()).planPrE2e(
      [
        "playwright/tests/expenses.spec.ts",
        "playwright/tests/new.spec.ts",
        "playwright/tests/old.spec.ts",
      ],
      [
        "playwright/tests/expenses.spec.ts",
        "playwright/tests/old.spec.ts",
        "playwright/tests/auth.setup.ts",
      ],
    );
    expect(plan.mainDefinitions).toEqual([
      "playwright/tests/auth.setup.ts",
      "playwright/tests/expenses.spec.ts",
      "playwright/tests/old.spec.ts",
    ]);
    expect(plan.changedDefinitions).toEqual([
      "playwright/tests/expenses.spec.ts",
      "playwright/tests/new.spec.ts",
      "playwright/tests/old.spec.ts",
    ]);
  });
});

describe("SCRUM-757 counted execution", () => {
  it("records complete passing counts bound to backend, frontend and controller", async () => {
    expect(
      (await load()).executionEvidence(report(), report(), identity),
    ).toMatchObject({
      ...identity,
      passed: 2,
      total: 2,
      skipped: 0,
      executedDefinitions: ["expenses.spec.ts"],
    });
  });

  it.each([
    "absent",
    "empty",
    "skipped",
    "failed",
    "interrupted",
    "missing-test",
    "wrong-project",
    "count-mismatch",
    "global-error",
    "expected-failure",
  ])("refuses %s execution evidence", async (shape) => {
    const actual = report();
    if (shape === "empty") actual.suites = [];
    if (shape === "skipped")
      actual.suites[0].specs[0].tests[0].results[0].status = "skipped";
    if (shape === "failed")
      actual.suites[0].specs[0].tests[0].status = "unexpected";
    if (shape === "interrupted")
      actual.suites[0].specs[0].tests[0].results[0].status = "interrupted";
    if (shape === "missing-test") actual.suites[0].specs.pop();
    if (shape === "wrong-project")
      actual.suites[0].specs[0].tests[0].projectName = "setup";
    if (shape === "count-mismatch") actual.stats.expected = 3;
    if (shape === "global-error")
      Object.assign(actual, { errors: [{ message: "worker crashed" }] });
    if (shape === "expected-failure")
      actual.suites[0].specs[0].tests[0].expectedStatus = "failed";
    const gate = await load();
    expect(() =>
      gate.executionEvidence(
        shape === "absent" ? undefined : actual,
        report(),
        identity,
      ),
    ).toThrow();
  });
});

type Run = {
  id: number;
  path: string;
  event: string;
  head_branch: string;
};
type Rec = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  external_id?: string;
  app: { slug: string };
  check_suite?: { id: number };
  output?: { title?: string; text?: string };
};
const REPOSITORY = "aalzriqat/Auto";
const SWARM_PATH = ".github/workflows/browser-attack-swarm.yml";
const swarm = (id: number): Run => ({
  id,
  path: SWARM_PATH,
  event: "workflow_run",
  head_branch: "main",
});
const forgedRun: Run = {
  id: 7,
  path: ".github/workflows/forge.yml",
  event: "push",
  head_branch: "feature",
};

/** API-created checks share an app suite; in this repository GitHub places them
 * in the dynamic CodeQL suite, independently of the workflow holding the token.
 * PATCH retains that suite. Explicit insert() fixtures also exercise legacy data. */
function github() {
  const records: Rec[] = [];
  const runsBySuite = new Map<number, Run>();
  const calls: string[] = [];
  const publications: Array<Record<string, unknown>> = [];
  let nextId = 9;
  let runLookup: "ok" | "fail" = "ok";
  let lagAfterPost = 0;
  let getFailures = 0;
  const scriptedListings: number[][] = [];
  let getOverride: Rec | undefined;
  const lag = new Map<number, number>();
  const api = async (
    method: string,
    route: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push(`${method} ${route.split("?")[0]}`);
    if (method !== "GET" && body) publications.push(structuredClone(body));
    if (method === "GET" && route.startsWith("/commits/")) {
      // GitHub's commit check-run listing is eventually consistent: a record
      // POSTed moments ago may be absent for a few listings.
      const scripted = scriptedListings.shift();
      if (scripted) return { check_runs: records.filter((entry) => scripted.includes(entry.id as number)).map((entry) => structuredClone(entry)) };
      const visible = records.filter((entry) => {
        const remaining = lag.get(entry.id) ?? 0;
        if (remaining <= 0) return true;
        lag.set(entry.id, remaining - 1);
        return false;
      });
      return { check_runs: visible };
    }
    if (method === "GET" && route.startsWith("/actions/runs?")) {
      if (runLookup === "fail") throw new Error("GitHub gate request failed.");
      const suite = Number(
        new URL(`https://x${route}`).searchParams.get("check_suite_id"),
      );
      const run = runsBySuite.get(suite);
      return {
        total_count: run ? 1 : 0,
        workflow_runs: run
          ? [{ ...run, check_suite_id: suite, repository: { full_name: REPOSITORY } }]
          : [],
      };
    }
    if (method === "POST") {
      const id = nextId++;
      runsBySuite.set(110584846427, {
        id: 40796582338,
        path: "dynamic/github-code-scanning/codeql",
        event: "dynamic",
        head_branch: "feature",
      });
      const record = {
        id,
        app: { slug: "github-actions" },
        check_suite: { id: 110584846427 },
        ...body,
      } as Rec;
      records.push(record);
      if (lagAfterPost > 0) lag.set(id, lagAfterPost);
      return record;
    }
    if (method === "GET" && /^\/check-runs\/\d+$/.test(route)) {
      if (getFailures > 0) {
        getFailures--;
        throw new Error("GitHub gate request failed.");
      }
      if (getOverride) return getOverride;
    }
    const record = records.find((entry) => `/check-runs/${entry.id}` === route);
    if (!record) throw new Error("no such check");
    Object.assign(record, body);
    return record;
  };
  const insert = (
    overrides: Partial<Rec>,
    run: Run | undefined,
    suite = 2000 + records.length,
  ) => {
    if (run) runsBySuite.set(suite, run);
    const record = {
      id: 500 + records.length,
      name: "authenticated-pr-e2e",
      head_sha: identity.headSha,
      status: "completed",
      conclusion: "success",
      app: { slug: "github-actions" },
      check_suite: { id: suite },
      ...overrides,
    } as Rec;
    records.push(record);
    return record;
  };
  return {
    api,
    records,
    calls,
    publications,
    insert,
    /** Records POSTed after this call stay out of the next `listings` listings. */
    lagNextPosts: (listings: number) => {
      lagAfterPost = listings;
    },
    /** Hide an existing record from the next `listings` listings. */
    hide: (record: Rec, listings: number) => {
      lag.set(record.id as number, listings);
    },
    /** The next `reads` GET /check-runs/{id} calls fail (5xx, timeout or 404 lag). */
    failGetById: (reads: number) => {
      getFailures = reads;
    },
    /** GET /check-runs/{id} returns this payload instead of the stored record. */
    answerGetWith: (record: Rec) => {
      getOverride = record;
    },
    clearLag: () => lag.clear(),
    /** The next listings show exactly these record ids, one array per listing. */
    scriptListings: (...listings: number[][]) => {
      scriptedListings.push(...listings);
    },
    breakRunLookup: () => {
      runLookup = "fail";
    },
    writes: () => calls.filter((call) => !call.startsWith("GET")),
  };
}
const publishInput = (runId: number, attempt = 1) => ({
  headSha: identity.headSha,
  prNumber: 42,
  repository: REPOSITORY,
  runId,
  runKey: `${runId}:${attempt}`,
  summary: "counts pending",
  detailsUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
});
const success = { conclusion: "success", reason: "counted suite passed" };

describe("SCRUM-757 check publication", () => {
  // SCRUM-760 / PR #704 round 2: no writer-controlled marker can prevent
  // trusted code from revoking a standing SUCCESS, including initialize.
  it.each([
    ["huge run id", "g5-publisher:swarm:9007199254740991:1"],
    ["missing", undefined],
    ["malformed", "not a publisher"],
    ["legitimately older", "g5-publisher:swarm:100:1"],
  ].flatMap(([label, text]) =>
    (["initialize", "begin", "reset", "finish"] as const).map((mode) => ({ label, text, mode })),
  ))("revokes standing success with $label marker during $mode", async ({ text, mode }) => {
    const gate = await load();
      const hub = github();
      // Even the formerly accepted trusted-suite shape cannot prove the last
      // PATCH writer or attempt. The record starts green before the invocation.
      const record = hub.insert({ output: { text } }, swarm(100));
      expect(record.conclusion).toBe("success");
      const result = await gate.publishPrE2eCheck(hub.api, {
        ...publishInput(200), mode,
        verdict: { conclusion: "failure", reason: "current execution failed" },
      });
      expect(result.outcome, mode).toBe("written");
      expect(record.conclusion, mode).toBe("failure");
      expect(hub.writes().length, mode).toBeGreaterThan(0);
      expect(hub.records, mode).toHaveLength(1);
  });

  it.each([
    undefined, "", "g5-publisher:swarm:200", "g5-publisher:swarm:200:0",
    "g5-publisher:swarm:9007199254740992:1",
    "g5-publisher:swarm:200:9007199254740992",
    "g5-publisher:other:200:1", "g5-publisher:admission:200:1",
    "g5-publisher:swarm:9007199254740991:1",
  ])("revokes before independently publishing current evidence despite marker %j", async (text) => {
    const hub = github();
    const record = hub.insert({ output: { text } }, swarm(100));
    const result = await (await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(200), mode: "finish", verdict: success,
    });
    expect(result.outcome).toBe("written");
    expect(hub.publications.map((body) => body.conclusion)).toEqual(["failure", "success"]);
    expect(record.conclusion).toBe("success");
    expect(hub.records).toHaveLength(1);
  });

  it("updates the same check across actual GitHub suite placement and retries", async () => {
    const hub = github();
    const gate = await load();
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(900), mode: "initialize" });
    const suite = hub.records[0].check_suite?.id;
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "begin" });
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "finish", verdict: success });
    expect(hub.records[0].conclusion).toBe("success");
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(100, 2), mode: "reset" });
    expect(hub.records[0].conclusion).toBe("failure");
    await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100, 2), mode: "finish",
      verdict: { conclusion: "failure", reason: "retry failed" },
    });
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].check_suite?.id).toBe(suite);
    expect(hub.records[0].conclusion).toBe("failure");
  });

  it.each([
    { external_id: "g5:42:99999999:1" },
    { external_id: "other:1" },
    { check_suite: undefined },
    { check_suite: { id: 123 } },
  ])("revokes standing success independently of suite or external id %j", async (overrides) => {
    const hub = github();
    const record = hub.insert(overrides, forgedRun);
    await (await load()).publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "begin" });
    expect(record.conclusion).toBe("failure");
    expect(hub.publications.every((body) => body.conclusion === "failure")).toBe(true);
  });

  it("does not depend on suite origin lookup being available", async () => {
    const hub = github();
    hub.insert({}, swarm(100));
    hub.breakRunLookup();
    await (await load()).publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "begin" });
    expect(hub.records[0].conclusion).toBe("failure");
  });

  it("revokes every duplicate and refuses later certification without adding checks", async () => {
    const hub = github();
    hub.insert({}, swarm(100));
    hub.insert({}, swarm(200));
    const gate = await load();
    for (const runId of [100, 200]) {
      expect((await gate.publishPrE2eCheck(hub.api, {
        ...publishInput(runId), mode: "finish", verdict: success,
      })).outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
      expect(hub.records).toHaveLength(2);
    }
  });

  it("revokes before rejecting an invalid trusted attempt", async () => {
    const hub = github();
    hub.insert({}, swarm(100));
    await expect((await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(100), runKey: "invalid", mode: "finish", verdict: success,
    })).rejects.toThrow("Trusted run attempt is unavailable.");
    expect(hub.records[0].conclusion).toBe("failure");
  });

  it("is armed only while no same-app success stands, including forged success", async () => {
    const hub = github();
    const gate = await load();
    expect(await gate.gateIsArmed(hub.api, identity.headSha)).toBe(true);
    hub.insert({}, forgedRun);
    expect(await gate.gateIsArmed(hub.api, identity.headSha)).toBe(false);
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "begin" });
    expect(await gate.gateIsArmed(hub.api, identity.headSha)).toBe(true);
  });

  it("refuses reset without a record and leaves other apps' checks alone", async () => {
    const hub = github();
    const gate = await load();
    await expect(gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "reset" })).rejects.toThrow();
    expect(hub.writes()).toEqual([]);
    const foreign = hub.insert({ app: { slug: "other-app" } }, undefined);
    await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "begin" });
    expect(foreign.conclusion).toBe("success");
    expect(hub.records).toHaveLength(2);
  });
});

// SCRUM-990: one admission invocation published initialize then finish about
// 2 s apart; the commit listing had not caught up, so finish POSTed a second
// record and every later begin quarantined the head.
describe("SCRUM-990 own-record continuity", () => {
  const failure = { conclusion: "failure", reason: "preflight did not succeed" };

  it("updates the record this invocation created even when the listing lags", async () => {
    const hub = github();
    hub.lagNextPosts(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    expect(first.outcome).toBe("written");
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure,
      ownRecordId: first.record?.id,
    });
    expect(second.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(hub.records[0].output?.title).toBe(failure.reason);
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
  });

  it("updates the record normally when the listing has caught up and own id is passed", async () => {
    const hub = github();
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: first.record?.id,
    });
    expect(second.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("success");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
  });

  // Round 2 (both review seats): listing lag plus an own-record read that also
  // fails must never fall through to a second POST.
  const noSleep = { sleep: async () => {}, confirmDelaysMs: [1000, 2000] };
  it.each([
    ["a 5xx or timeout", 99],
    ["a 404 lag that outlasts every attempt", 3],
  ])("refuses with no second POST when the listing lags and GET by id fails (%s)", async (_label, failures) => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(failures);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const ownId = first.record?.id as number;
    expect(ownId).toBe(9);
    const delays: number[] = [];
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: ownId,
      sleep: async (ms: number) => { delays.push(ms); }, confirmDelaysMs: [1000, 2000],
    });
    expect(second.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual(["POST /check-runs"]);
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(delays).toEqual([1000, 2000]);
  });

  it("confirms by id after a transient GET failure and updates without a second POST", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure, ownRecordId: first.record?.id, ...noSleep,
    });
    expect(second.outcome).toBe("written");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
    expect(hub.records).toHaveLength(1);
  });

  it("confirms through a later listing when GET by id keeps failing", async () => {
    const hub = github();
    hub.lagNextPosts(3); // hidden from the initial listing and the first two re-lists
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure, ownRecordId: first.record?.id, ...noSleep,
    });
    expect(second.outcome).toBe("written");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
    expect(hub.records).toHaveLength(1);
  });

  it("still quarantines a really existing second record even when ownRecordId is passed", async () => {
    const hub = github();
    hub.lagNextPosts(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    hub.insert({}, swarm(300)); // created by someone else in between
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: first.record?.id,
    });
    expect(second.outcome).toBe("quarantined");
    expect(hub.records).toHaveLength(2);
    expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
  });

  it.each([
    ["a foreign-app record", { app: { slug: "other-app" } }],
    ["a differently named record", { name: "something-else" }],
    ["a record for another head", { head_sha: "f".repeat(40) }],
  ])("refuses with zero writes when ownRecordId points to %s", async (_label, overrides) => {
    const hub = github();
    const foreign = hub.insert(overrides, undefined);
    hub.hide(foreign, 5);
    const before = structuredClone(foreign);
    const result = await (await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success,
      ownRecordId: foreign.id as number, ...noSleep,
    });
    expect(result.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual([]);
    expect(foreign).toEqual(before);
    expect(hub.records).toHaveLength(1);
  });

  it("refuses with zero writes when GET by id answers with a different id", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    hub.answerGetWith({ ...(hub.records[0] as Rec), id: 7777 });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: first.record?.id, ...noSleep,
    });
    expect(second.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual(["POST /check-runs"]);
  });

  it("refuses with zero writes when ownRecordId cannot be read at all", async () => {
    const hub = github();
    const result = await (await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: 424242, ...noSleep,
    });
    expect(result.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual([]);
    expect(hub.records).toHaveLength(0);
  });

  it("recovers after a refusal: a fresh initialize on the same head ends with one record", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const refused = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: first.record?.id, ...noSleep,
    });
    expect(refused.outcome).toBe("unconfirmed");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    // The listing catches up; the rerun has no ownRecordId.
    hub.clearLag();
    const rerun = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100, 2), mode: "initialize" });
    expect(rerun.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(hub.writes().filter((call) => call === "POST /check-runs")).toHaveLength(1);
  });

  it("recovers after a refusal: a rerun with a NEW runKey PATCHes the one record in both publications", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const refused = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: first.record?.id, ...noSleep,
    });
    expect(refused.outcome).toBe("unconfirmed");
    hub.clearLag();
    hub.failGetById(0);
    const rerun = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100, 2), mode: "initialize" });
    expect(rerun.outcome).toBe("written");
    const final = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100, 2), mode: "finish", verdict: failure, ownRecordId: rerun.record?.id,
    });
    expect(final.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].external_id).toBe("g5:42:100:2");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9", "PATCH /check-runs/9"]);
  });

  // Round 3: every distinct same-name record observed anywhere in the
  // publication (initial listing, any re-list, a read by id) is counted once.
  describe("duplicates observed across different reads", () => {
    async function ownAndOther() {
      const hub = github();
      hub.lagNextPosts(100);
      const gate = await load();
      const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
      const other = hub.insert({}, swarm(300));
      return { hub, gate, own: first.record?.id as number, other: other.id as number };
    }
    const finishWith = (gate: Awaited<ReturnType<typeof load>>, hub: ReturnType<typeof github>, own: number) =>
      gate.publishPrE2eCheck(hub.api, {
        ...publishInput(100), mode: "finish", verdict: success, ownRecordId: own, ...noSleep,
      });

    it("quarantines when the initial list is empty, GET fails, a re-list shows only the other record, then GET confirms", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([], [other]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
      expect(hub.writes().filter((call) => call.startsWith("POST"))).toHaveLength(1);
    });

    it("quarantines when the initial list shows only the other record and a later re-list shows only the own record", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([other], [own]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
    });

    it("quarantines when a re-list shows both records together", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([], [own, other]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
    });

    it("counts a record seen in several observations once", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([other], [other], [other]);
      hub.failGetById(2);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      // The own record is already failed; the other is revoked once, not once
      // per observation (each listing hands back a fresh copy, as GitHub does).
      expect(hub.writes()).toEqual(["POST /check-runs", `PATCH /check-runs/${other}`]);
    });

    it("still writes when only the own record is ever observed, however often", async () => {
      const { hub, gate, own } = await ownAndOther();
      hub.records.pop(); // the other record never existed
      hub.scriptListings([], [own]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("written");
      expect(hub.writes()).toEqual(["POST /check-runs", `PATCH /check-runs/${own}`]);
    });

    it("refuses an anomaly immediately: one read by id, no sleep, no re-list", async () => {
      const hub = github();
      const foreign = hub.insert({ app: { slug: "other-app" } }, undefined);
      hub.hide(foreign, 5);
      const gate = await load();
      const before = hub.calls.length;
      let sleeps = 0;
      const result = await gate.publishPrE2eCheck(hub.api, {
        ...publishInput(100), mode: "finish", verdict: success, ownRecordId: foreign.id as number,
        sleep: async () => { sleeps++; }, confirmDelaysMs: [1000, 2000],
      });
      expect(result.outcome).toBe("unconfirmed");
      expect(sleeps).toBe(0);
      expect(hub.calls.slice(before).map((call) => call.split("/").slice(0, 2).join("/"))).toEqual([
        "GET /commits", "GET /check-runs",
      ]);
    });
  });
});

describe("SCRUM-757 PR verdict", () => {
  it("explicitly succeeds for documentation-only PRs with a recorded reason", async () => {
    const gate = await load();
    expect(
      gate.prE2eVerdict({
        plan: gate.planPrE2e(["docs/gate.md"], []),
        fresh: true,
      }),
    ).toMatchObject({
      conclusion: "success",
      reason: expect.stringContaining("documentation"),
    });
  });

  it.each([
    "fork",
    "failed",
    "cancelled",
    "skipped",
    "missing",
    "stale",
    "wrong-sha",
  ])("fails closed for %s in-scope PRs", async (shape) => {
    const gate = await load();
    expect(
      gate.prE2eVerdict({
        plan: gate.planPrE2e(["app/page.tsx"], []),
        ...identity,
        fresh: shape !== "stale",
        sameRepository: shape !== "fork",
        result: ["failed", "cancelled", "skipped"].includes(shape)
          ? shape
          : "success",
        evidence:
          shape === "missing"
            ? undefined
            : {
                ...gate.executionEvidence(report(), report(), identity),
                testedSha:
                  shape === "wrong-sha" ? "d".repeat(40) : identity.testedSha,
              },
      }).conclusion,
    ).toBe("failure");
  });

  it("accepts counted exact-candidate execution", async () => {
    const gate = await load();
    expect(
      gate.prE2eVerdict({
        plan: gate.planPrE2e(["app/page.tsx"], []),
        ...identity,
        fresh: true,
        sameRepository: true,
        result: "success",
        evidence: gate.executionEvidence(report(), report(), identity),
      }).conclusion,
    ).toBe("success");
  });

  it("orders definitions by UTF-16 code unit, never by locale or insertion order (S2871)", async () => {
    const gate = await load();
    const plan = gate.planPrE2e(
      ["playwright/tests/b.spec.ts", "playwright/tests/B.spec.ts", "playwright/tests/a.spec.ts"],
      ["playwright/tests/b.spec.ts", "playwright/tests/B.spec.ts", "playwright/tests/a.spec.ts"],
    );
    expect(plan.mainDefinitions).toEqual([
      "playwright/tests/B.spec.ts",
      "playwright/tests/a.spec.ts",
      "playwright/tests/b.spec.ts",
    ]);
    expect(plan.changedDefinitions).toEqual(plan.mainDefinitions);
  });

  it("has no comparator-less sort() in the judge module (Sonar S2871)", () => {
    const source = readFileSync(
      new URL("./trustedPrE2eGate.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.sort\(\s*\)/);
  });
});
