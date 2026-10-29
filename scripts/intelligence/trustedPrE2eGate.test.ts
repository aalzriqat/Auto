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
  const api = async (
    method: string,
    route: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push(`${method} ${route.split("?")[0]}`);
    if (method !== "GET" && body) publications.push(structuredClone(body));
    if (method === "GET" && route.startsWith("/commits/"))
      return { check_runs: records };
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
      return record;
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
