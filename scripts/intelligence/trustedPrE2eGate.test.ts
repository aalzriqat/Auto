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

describe("SCRUM-757 check publication", () => {
  it("updates one GitHub Actions check on reruns and refuses an older attempt's late verdict", async () => {
    const records: Array<Record<string, unknown>> = [];
    const api = async (
      method: string,
      route: string,
      body?: Record<string, unknown>,
    ) => {
      if (method === "GET") return { check_runs: records };
      if (method === "POST") {
        records.push({ id: 9, app: { slug: "github-actions" }, ...body });
        return records[0];
      }
      Object.assign(records[0], body);
      return records[0];
    };
    const gate = await load();
    const input = {
      headSha: identity.headSha,
      prNumber: 42,
      runKey: "100:1",
      summary: "counts pending",
      detailsUrl: "https://github.com/aalzriqat/Auto/actions/runs/100",
    };
    await gate.publishPrE2eCheck(api, { ...input, mode: "begin" });
    await gate.publishPrE2eCheck(api, {
      ...input,
      runKey: "100:2",
      mode: "begin",
    });
    await expect(
      gate.publishPrE2eCheck(api, {
        ...input,
        mode: "finish",
        verdict: { conclusion: "success", reason: "obsolete" },
      }),
    ).rejects.toThrow();
    await gate.publishPrE2eCheck(api, {
      ...input,
      runKey: "100:2",
      mode: "finish",
      verdict: { conclusion: "failure", reason: "cannot run" },
    });
    await gate.publishPrE2eCheck(api, {
      ...input,
      runKey: "100:2",
      mode: "finish",
      verdict: { conclusion: "success", reason: "counted suite passed" },
    });
    // Re-running only the E2E job does not re-run its upstream begin job.
    // Its later red verdict must still revoke the preceding green result.
    await gate.publishPrE2eCheck(api, {
      ...input,
      runKey: "100:3",
      mode: "finish",
      verdict: { conclusion: "failure", reason: "job-only rerun failed" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      head_sha: identity.headSha,
      name: "authenticated-pr-e2e",
      conclusion: "failure",
    });
  });

  it("does not let a late PR listener overwrite the consumer verdict", async () => {
    const api = async () => ({
      check_runs: [
        {
          id: 9,
          app: { slug: "github-actions" },
          name: "authenticated-pr-e2e",
          external_id: "g5:42:100:1",
          conclusion: "success",
        },
      ],
    });
    expect(
      await (
        await load()
      ).publishPrE2eCheck(api, {
        headSha: identity.headSha,
        prNumber: 42,
        mode: "initialize",
      }),
    ).toMatchObject({ conclusion: "success" });
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