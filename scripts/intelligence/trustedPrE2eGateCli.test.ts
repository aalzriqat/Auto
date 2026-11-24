// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGate } from "./trustedPrE2eGateCli.mjs";
import { SOURCED_SCENARIO_IDS } from "./trustedBrowserReplayPolicy.mjs";

import { controllerSha, headSha, scenario, testedSha } from "../../test-utils/trustedPrE2eGateCliScenario";

describe("SCRUM-762 trusted replay producer", () => {
  it.each([
    { suite: "explorer", file: "jev-explorer.spec.ts", ids: Array.from({ length: 12 }, (_, index) => `e${index}`), duplicateTitle: false },
    { suite: "explorer", file: "jev-explorer.spec.ts", ids: Array.from({ length: 12 }, (_, index) => `e${index}`), duplicateTitle: true },
    { suite: "explorer", file: "jev-explorer.spec.ts", ids: Array.from({ length: 12 }, (_, index) => `e${index}`), duplicateTitle: false, failedExecution: true },
    { suite: "sourced", file: "pilot-sourced.spec.ts", ids: SOURCED_SCENARIO_IDS, duplicateTitle: false },
    { suite: "sourced", file: "pilot-sourced.spec.ts", ids: SOURCED_SCENARIO_IDS, duplicateTitle: true },
    { suite: "sourced", file: "pilot-sourced.spec.ts", ids: SOURCED_SCENARIO_IDS, duplicateTitle: false, failedExecution: true },
  ])("publishes $suite evidence only for the full bound execution ($duplicateTitle, $failedExecution)", async ({ suite, file, ids, duplicateTitle, failedExecution }) => {
    const root = mkdtempSync(path.join(process.cwd(), ".autoflow-g5-"));
    if (path.dirname(root) !== process.cwd() || !path.basename(root).startsWith(".autoflow-g5-")) {
      throw new Error("Unsafe producer fixture cleanup path");
    }
    try {
      const g5 = path.join(root, "g5");
      const inputs = path.join(root, `${suite}-local`);
      const registry = path.join(root, "regression", "scenarios");
      const testDir = path.join(root, "playwright", "scenarios");
      for (const dir of [g5, inputs, registry, testDir]) mkdirSync(dir, { recursive: true });
      const titles = ids.map((_, index) => `pilot ${suite} ${index}`);
      for (const [index, title] of titles.entries()) {
        writeFileSync(path.join(registry, `e${index}.scenario.json`), JSON.stringify({
          id: ids[index], status: "active", level: "browser", domain: "screen",
          impl: { file: `playwright/scenarios/${file}`, testName: duplicateTitle && index === ids.length - 1 ? titles[0] : title },
        }));
      }
      if (!duplicateTitle) {
        const require = createRequire(import.meta.url);
        const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
        const configFile = "playwright.scenarios.config.ts";
        writeFileSync(path.join(root, configFile), `export default { testDir: "./playwright/scenarios", projects: [{ name: "chromium" }] };`);
        const failure = suite === "explorer"
          ? 'console.warn("EXPLORER_BACKEND_ATTESTATION_FAILED (CONVEX_ASSERTION)"); console.warn("PRIVATE_BROWSER_DETAIL EXPLORER_BACKEND_ATTESTATION_FAILED (TIMEOUT)"); console.warn("EXPLORER_BACKEND_ATTESTATION_FAILED (CONVEX_ASSERTION)"); console.warn("EXPLORER_BACKEND_ATTESTATION_FAILED (PRIVATE_BROWSER_DETAIL)"); throw new Error("PRIVATE_BROWSER_DETAIL");'
          : 'throw new Error("PRIVATE_BROWSER_DETAIL");';
        writeFileSync(path.join(testDir, file), 'import { test } from "@playwright/test";\n' +
          titles.map((title, index) => `test(${JSON.stringify(title)}, () => {${failedExecution && index === 0 ? failure : ""}});`).join("\n"));
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (key.startsWith("PLAYWRIGHT_JSON_")) delete env[key];
        const args = [cli, "test", "-c", configFile, "--project=chromium", "--no-deps", "--workers=1", "--retries=0", "--reporter=json", file];
        for (const [output, extra] of [["discovery.json", ["--list"]], ["results.json", []]] as const) {
          const nativeReport = spawnSync(process.execPath, [...args, ...extra], { cwd: root, env, timeout: 10000 });
          expect(nativeReport.status).toBe(output === "results.json" && failedExecution ? 1 : 0);
          writeFileSync(path.join(inputs, output), nativeReport.stdout);
        }
      }
      const baseSha = "c".repeat(40);
      const evidencePath = path.join(g5, `${suite}-evidence.json`);
      const gateEnvironment = {
        G5_REPO_ROOT: root, GITHUB_WORKFLOW_SHA: controllerSha, BASE_SHA: baseSha, HEAD_SHA: headSha,
        TESTED_SHA: testedSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
      };
      const produce = runGate(`${suite}-evidence`, gateEnvironment);
      if (duplicateTitle) {
        await expect(produce).rejects.toThrow(`Trusted ${suite} bindings are incomplete or ambiguous.`);
        expect(() => readFileSync(evidencePath)).toThrow();
      } else if (failedExecution) {
        await expect(produce).rejects.toThrow();
        const messages = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await runGate(`${suite}-diagnostics`, gateEnvironment);
          const expected = [`Trusted ${suite} replay ${ids[0]}: TEST_FAILED`];
          if (suite === "explorer") expected.push(
            "Trusted explorer reported attestation stage: CONVEX_ASSERTION",
            "Trusted explorer reported attestation stage: TIMEOUT",
          );
          expect(messages.mock.calls.map(([message]) => message)).toEqual(expected);
          expect(JSON.stringify(messages.mock.calls)).not.toContain("PRIVATE_BROWSER_DETAIL");
          expect(() => readFileSync(evidencePath)).toThrow();
        } finally {
          messages.mockRestore();
        }
      } else {
        await produce;
        const { records, ...binding } = JSON.parse(readFileSync(evidencePath, "utf8"));
        expect(binding).toEqual({
          baseSha, headSha, testedSha, controllerSha, producerRunId: "123", producerAttempt: "1",
        });
        expect(records).toHaveLength(ids.length);
        expect(records).toEqual(expect.arrayContaining(ids.map(id => ({ id, code: "PASS" }))));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25000);

  const binding = {
    id: "g8-owned-cash-delivery-screen",
    status: "active",
    domain: "screen",
    level: "browser",
    impl: { file: "playwright/tests/sales.spec.ts", testName: "deliver a cash sale" },
  };
  const financedBinding = {
    ...binding,
    id: "g8-owned-financed-delivery-screen",
    impl: { file: "playwright/tests/financed-deal-economics.spec.ts", testName: "deliver a financed sale" },
  };
  const wrongFinancedBinding = {
    ...financedBinding,
    impl: { ...financedBinding.impl, file: "playwright/tests/expenses.spec.ts" },
  };
  const supplierArabic = {
    ...binding,
    id: "supplier-p7-browser-ar",
    impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier identity in Arabic" },
  };
  const supplierEnglish = {
    ...supplierArabic,
    id: "supplier-p7-browser-en",
    impl: { ...supplierArabic.impl, testName: "supplier identity in English" },
  };
  it.each([
    { name: "valid", records: [binding], code: "PASS" },
    { name: "valid cash and financed", records: [binding, financedBinding], code: "PASS", additionalFixtures: [financedBinding] },
    {
      name: "financed scenario mapped to a different passing definition",
      records: [binding, wrongFinancedBinding],
      code: "PASS",
      additionalFixtures: [financedBinding, { ...wrongFinancedBinding, id: "another-expense-case" }],
      financedCode: "BINDING_UNAVAILABLE",
    },
    {
      name: "valid supplier Arabic and English",
      records: [binding, supplierArabic, supplierEnglish],
      code: "PASS",
      additionalFixtures: [supplierArabic, supplierEnglish],
    },
    { name: "missing", records: [], code: "BINDING_UNAVAILABLE" },
    { name: "duplicate", records: [binding, binding], code: "BINDING_UNAVAILABLE" },
    { name: "retired", records: [{ ...binding, status: "retired" }], code: "BINDING_UNAVAILABLE" },
    { name: "wrong domain", records: [{ ...binding, domain: "money" }], code: "BINDING_UNAVAILABLE" },
    { name: "wrong level", records: [{ ...binding, level: "backend" }], code: "BINDING_UNAVAILABLE" },
    { name: "malformed", records: [null], code: "BINDING_UNAVAILABLE" },
    { name: "unreadable", records: [], unreadable: true, code: "BINDING_UNAVAILABLE" },
  ])("writes the counted evidence for a $name binding", async ({ records, unreadable, code, additionalFixtures = [], financedCode = code }) => {
    const root = mkdtempSync(path.join(process.cwd(), ".autoflow-g5-"));
    if (path.dirname(root) !== process.cwd() || !path.basename(root).startsWith(".autoflow-g5-")) {
      throw new Error("Unsafe producer fixture cleanup path");
    }
    try {
      const g5 = path.join(root, "g5");
      const scenarios = path.join(root, "regression", "scenarios");
      const testDir = path.join(root, "playwright", "tests");
      for (const dir of [g5, scenarios, testDir]) mkdirSync(dir, { recursive: true });
      const fixtures = [binding, ...additionalFixtures];
      for (const fixture of fixtures) writeFileSync(path.join(root, fixture.impl.file), "");
      records.forEach((record, index) => {
        writeFileSync(path.join(scenarios, `${index}.scenario.json`), JSON.stringify(record));
      });
      if (unreadable) writeFileSync(path.join(scenarios, "broken.scenario.json"), "{");
      const config = {
        configFile: path.join(root, "playwright.config.ts"),
        rootDir: testDir,
        projects: [{ id: "chromium", name: "chromium", testDir }],
        argv: ["test", "--project=chromium"],
      };
      const report = (listed: boolean) => ({
        config,
        errors: [],
        stats: { expected: listed ? 0 : fixtures.length, unexpected: 0, flaky: 0, skipped: listed ? fixtures.length : 0 },
        suites: [{ specs: fixtures.map((fixture) => ({
          id: fixture.id, file: path.basename(fixture.impl.file), title: fixture.impl.testName,
          tests: [{
            projectId: "chromium", projectName: "chromium", expectedStatus: "passed",
            status: listed ? "skipped" : "expected",
            results: listed ? [] : [{ status: "passed", retry: 0 }],
          }],
        })) }],
      });
      writeFileSync(path.join(g5, "results.json"), JSON.stringify(report(false)));
      writeFileSync(path.join(g5, "discovery.json"), JSON.stringify(report(true)));
      const summary = path.join(g5, "summary.md");
      await runGate("evidence", {
        G5_REPO_ROOT: root, GITHUB_WORKFLOW_SHA: controllerSha, HEAD_SHA: headSha,
        TESTED_SHA: testedSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: summary,
      });
      const expected = { id: binding.id, code, producerRunId: "123", producerAttempt: "1" };
      expect(JSON.parse(readFileSync(path.join(g5, "evidence.json"), "utf8"))).toMatchObject({
        headSha, testedSha, controllerSha, total: fixtures.length, passed: fixtures.length, browserReplay: expected,
        ...(additionalFixtures.includes(financedBinding) ? { financedReplay: { ...expected, id: financedBinding.id, code: financedCode } } : {}),
        ...(additionalFixtures.includes(supplierArabic) ? {
          supplierArabicReplay: { ...expected, id: supplierArabic.id },
          supplierEnglishReplay: { ...expected, id: supplierEnglish.id },
        } : {}),
      });
      expect(readFileSync(summary, "utf8")).toContain(code);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SCRUM-757 native judge with GitHub API boundary fixtures", () => {
  it.each([false, true])(
    "publishes explicit docs-only success, fork=%s",
    async (fork) => {
      const { records, summary } = await scenario({ fork });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        name: "authenticated-pr-e2e",
        head_sha: headSha,
        conclusion: "success",
      });
      expect(summary).toContain("documentation Markdown only");
      expect(summary).toContain("Main test definitions");
    },
  );
  it.each<NonNullable<Parameters<typeof scenario>[0]>>([
    { files: ["app/page.tsx"], fork: true },
    { files: ["app/page.tsx"] },
    { incomplete: true },
    { files: ["app/page.tsx"], mode: "finish", preflight: "failure" },
    { files: ["app/page.tsx"], mode: "finish", result: "skipped" },
    { files: ["app/page.tsx"], mode: "finish", moved: true },
  ])(
    "publishes failure when execution or scope cannot be certified: %j",
    async (options) => {
      const { records } = await scenario(options);
      expect(records).toHaveLength(1);
      expect(records[0].conclusion).toBe("failure");
    },
  );
  it("binds the successful consumer result and full counts to the PR head", async () => {
    const { records, summary } = await scenario({
      files: ["app/page.tsx", "playwright/tests/new.spec.ts"],
      mode: "finish",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      head_sha: headSha,
      conclusion: "success",
    });
    expect(summary).toContain("57/57");
    expect(summary).toContain(testedSha);
    expect(summary).toContain("playwright/tests/new.spec.ts");
  });
  it.each<NonNullable<Parameters<typeof scenario>[0]>>([
    { envOverride: { EVIDENCE_ARTIFACT_ID: undefined } },
    { artifactPatch: { name: "trusted-g5-evidence-123-2" } },
    { artifactPatch: { expired: true } },
    { artifactPatch: { workflow_run: { id: 122, head_sha: controllerSha, head_branch: "main", repository_id: 1234, head_repository_id: 1234 } } },
    { artifactPatch: { workflow_run: { id: 123, head_sha: controllerSha, head_branch: "main", repository_id: 1234, head_repository_id: 9999 } } },
  ])("refuses counted evidence whose artifact provenance cannot be verified: %j", async (options) => {
    const { records, publications } = await scenario({ ...options, files: ["app/page.tsx"], mode: "finish" });
    expect(records[0].conclusion).toBe("failure");
    expect(publications.some((body) => body.conclusion === "success")).toBe(false);
  });

  it.each([
    { label: "current producer", published: true },
    { label: "stale producer attempt", producerAttempt: "2", published: false },
    { label: "moved merge", moved: true, published: false },
    { label: "failed execution", result: "failure", published: false },
    { label: "superseded workflow", freshness: "new-attempt", published: false },
    { label: "different artifact attempt", artifactPatch: { name: "trusted-g5-evidence-123-2" }, published: false },
    { label: "quarantined publication", duplicateOnFinish: true, published: false },
  ])("publishes the exact replay receipt only for a verified run: $label", async ({
    published, producerAttempt = "1", moved, result, freshness, artifactPatch, duplicateOnFinish,
  }) => {
    const { records, summary } = await scenario({
      files: ["components/applications/cockpit/DealCockpit.tsx"],
      mode: "finish",
      moved,
      result,
      freshness,
      artifactPatch,
      duplicateOnFinish,
      browserReplay: {
        id: "g8-owned-cash-delivery-screen",
        code: "PASS",
        producerRunId: "123",
        producerAttempt,
      },
    });
    const output = records[0].output as { summary: string };
    expect(summary.includes("Verified browser replay")).toBe(published);
    expect(output.summary.includes("Verified browser replay")).toBe(published);
    expect(output.summary.includes("g8-owned-cash-delivery-screen")).toBe(published);
  });
  it.each(["browserReplay", "financedReplay"] as const)("publishes only the owned case with the current attempt when %s is stale", async (stale) => {
    const cash = "g8-owned-cash-delivery-screen";
    const financed = "g8-owned-financed-delivery-screen";
    const observed = { code: "PASS", producerRunId: "123" };
    const { summary, records } = await scenario({
      files: ["components/applications/cockpit/DealCockpit.tsx"],
      mode: "finish",
      browserReplay: { ...observed, id: cash, producerAttempt: stale === "browserReplay" ? "2" : "1" },
      financedReplay: { ...observed, id: financed, producerAttempt: stale === "financedReplay" ? "2" : "1" },
    });
    const acceptedId = stale === "browserReplay" ? financed : cash;
    const refusedId = stale === "browserReplay" ? cash : financed;
    expect(summary).toContain(`Verified browser replay: ${acceptedId}`);
    expect(summary).not.toContain(refusedId);
    expect(records[0].output).toMatchObject({ summary });
  });

  it("resolves a same-repository PR through the commit lookup when workflow_run.pull_requests is empty", async () => {
    const { records } = await scenario({ mode: "finish", noPrArray: true });
    expect(records[0]).toMatchObject({
      head_sha: headSha,
      conclusion: "success",
    });
  });

  it("takes the pull_requests entry that targets main at the reported head, never the first entry", async () => {
    const wrongBase = {
      number: 41,
      base: { ref: "release", sha: controllerSha },
      head: { sha: headSha },
    };
    const wrongHead = {
      number: 40,
      base: { ref: "main", sha: controllerSha },
      head: { sha: "c".repeat(40) },
    };
    const { records, summary } = await scenario({
      mode: "finish",
      pullRequests: (pr) => [wrongBase, wrongHead, pr],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ head_sha: headSha });
    expect(records[0].external_id).toContain("g5:42:");
    expect(summary).toContain(headSha);
  });

  it("refuses to publish for a PR identity it cannot pin to main and the reported head", async () => {
    await expect(
      scenario({
        mode: "finish",
        noPrArray: true,
        // The commit lookup is the last resort and finds a PR into another base.
        wrongLookup: true,
      }),
    ).rejects.toThrow("Exact triggering PR identity unavailable.");
  });

  it.each(["initialize", "begin", "reset", "finish"] as const)(
    "turns a forged success under the gate name into failure in %s mode instead of leaving it",
    async (mode) => {
      const { records, verdict } = await scenario({
        files: ["app/page.tsx"],
        result: "failure",
        mode,
        forged: true,
      });
      expect(records.map((record) => record.conclusion)).not.toContain(
        "success",
      );
      expect(records).toHaveLength(1);
      if (mode === "initialize" || mode === "finish")
        expect(verdict?.conclusion).toBe("failure");
      else expect(verdict).toBeUndefined();
    },
  );

  describe("when sibling jobs keep the trusted producer queued", () => {
    const publisher = {
      id: 321, run_id: 123, run_attempt: 1, head_sha: controllerSha,
      name: "authenticated-pr-e2e-publish", status: "in_progress", conclusion: null,
      check_run_url: "https://api.github.com/repos/aalzriqat/Auto/check-runs/321",
    };
    const queued = {
      mode: "finish" as const, files: ["app/page.tsx"],
      producerPatch: { status: "queued", conclusion: null },
      envOverride: { GITHUB_JOB: "e2e-gate-finish", G5_PUBLISHER_CHECK_RUN_ID: "321" },
      publisherJob: publisher,
    };

    it("publishes only after reading the running job bound to the trusted step's check-run ID", async () => {
      const calls: string[] = [];
      const { records, verdict } = await scenario({ ...queued, calls, forged: true });
      expect(verdict?.conclusion).toBe("success");
      expect(calls.filter((url) => url.includes("/actions/jobs/"))).toEqual([
        "https://api.github.com/repos/aalzriqat/Auto/actions/jobs/321",
      ]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ conclusion: "success", head_sha: headSha, external_id: "g5:42:123:1" });
    });

    it.each([
      ["waiting publisher", { publisherJob: { ...publisher, status: "queued" } }],
      ["completed publisher", { publisherJob: { ...publisher, status: "completed" } }],
      ["different publisher id", { publisherJob: { ...publisher, id: 322 } }],
      ["different check binding", { publisherJob: { ...publisher, check_run_url: publisher.check_run_url.replace("/321", "/322") } }],
      ["contradictory publisher conclusion", { publisherJob: { ...publisher, conclusion: "cancelled" } }],
      ["different job attempt", { publisherJob: { ...publisher, run_attempt: 2 } }],
      ["foreign run", { publisherJob: { ...publisher, run_id: 999 } }],
      ["foreign controller", { publisherJob: { ...publisher, head_sha: headSha } }],
      ["different job name", { publisherJob: { ...publisher, name: "trusted-e2e" } }],
      ["missing publisher", { publisherJob: null }],
      ["wrong job context", { envOverride: { ...queued.envOverride, GITHUB_JOB: "trusted-e2e" } }],
      ["superseded producer", { freshness: "new-attempt" }],
      ["superseded source", { freshness: "new-source-run" }],
      ["cancelled producer", { producerPatch: { status: "completed", conclusion: "cancelled" } }],
      ["contradictory queued producer conclusion", { producerPatch: { status: "queued", conclusion: "cancelled" } }],
      ["admission job", { mode: "initialize" as const, files: ["docs/gate.md"] }],
    ] as const)("refuses to publish success with %s", async (_label, overrides) => {
      const { verdict, publications } = await scenario({ ...queued, ...overrides, forged: true });
      expect(verdict).toMatchObject({
        conclusion: "failure",
        reason: "The trusted workflow or triggering execution has been superseded or cannot be verified.",
      });
      expect(publications.some((body) => body.conclusion === "success")).toBe(false);
    });

    it.each([undefined, "3e2", "321/../322"])("fails closed before requesting malformed publisher id %s", async (id) => {
      const calls: string[] = [];
      const { verdict, publications } = await scenario({
        ...queued, calls, forged: true, envOverride: { ...queued.envOverride, G5_PUBLISHER_CHECK_RUN_ID: id },
      });
      expect(verdict?.conclusion).toBe("failure");
      expect(calls.some((url) => url.includes("/actions/jobs/"))).toBe(false);
      expect(publications.some((body) => body.conclusion === "success")).toBe(false);
    });
  });

  // Replaces marker-based ordering regressions with authoritative Actions data:
  // late success from an older source run, source attempt or consumer attempt.
  it.each(["new-source-run", "new-source-attempt", "new-attempt", "cancelled", "wrong-workflow", "unreadable",
    "wrong-controller", "wrong-head-repository",
    "empty-inventory", "missing-source", "malformed-inventory", "later-page-new-source",
    "oversized-inventory", "missing-total", "count-mismatch", "duplicate-inventory"])(
    "revokes a standing success and refuses a stale consumer: %s", async (freshness) => {
      const { records, verdict, publications } = await scenario({
        mode: "finish", files: ["app/page.tsx"], forged: true, freshness,
      });
      expect(verdict?.conclusion).toBe("failure");
      expect(records).toHaveLength(1);
      expect(records[0].conclusion).toBe("failure");
      expect(publications.some((body) => body.conclusion === "success")).toBe(false);
    },
  );

  it("refuses to arm a job while a success stands and allows it once the gate is red", async () => {
    const standing = await scenario({ mode: "armed", forged: true });
    expect(standing.verdict?.conclusion).toBe("failure");
    expect(standing.verdict?.reason).toContain("Re-run all jobs");
    const red = await scenario({ mode: "armed" });
    expect(red.verdict).toBeUndefined();
    expect(red.records).toHaveLength(0);
  });

  it("resets an existing record to failure without scope I/O", async () => {
    const { records, verdict } = await scenario({
      files: ["docs/gate.md"],
      mode: "reset",
    });
    expect(verdict).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe("failure");
  });
  it("starts git by a fixed absolute path, never a bare name resolved through PATH (Sonar S4036)", () => {
    const source = readFileSync(
      new URL("./trustedPrE2eGateCli.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/execFileSync\(\s*"git"/);
    expect(source).toContain("resolveGit");
  });

  // Sonar jssecurity:S7044 (API traversal) and S8476 (client-side request
  // forgery): the request URL is built from the environment, the event payload
  // and API responses. Each must be validated before any request is made.
  const REFUSES_BEFORE_ANY_REQUEST = ["initialize", "armed"] as const;

  it.each([
    "https://evil.example.com",
    "http://api.github.com",
    "https://api.github.com/enterprise",
    "https://api.github.com/api/v3",
    "https://api.github.com:8443",
    "https://user:secret@api.github.com",
    "https://api.github.com?x=1",
    "https://api.github.com#frag",
    "https://api.github.com#",
    "https://api.github.com.evil.example",
    "https://evil.example/https://api.github.com",
    "//api.github.com",
    "",
  ])("refuses GITHUB_API_URL %j before any request", async (apiUrl) => {
    for (const mode of REFUSES_BEFORE_ANY_REQUEST) {
      const calls: string[] = [];
      await expect(
        scenario({ mode, calls, envOverride: { GITHUB_API_URL: apiUrl } }),
      ).rejects.toThrow("Invalid GitHub API origin.");
      expect(calls).toEqual([]);
    }
  });

  it("refuses a missing GITHUB_API_URL before any request", async () => {
    const calls: string[] = [];
    await expect(
      scenario({ calls, envOverride: { GITHUB_API_URL: undefined } }),
    ).rejects.toThrow("Invalid GitHub API origin.");
    expect(calls).toEqual([]);
  });

  it.each(["../..", "owner/..", "./name", "../../x"])(
    "refuses repository %j (dot segments) before any request",
    async (repository) => {
      const calls: string[] = [];
      await expect(
        scenario({ calls, envOverride: { GITHUB_REPOSITORY: repository } }),
      ).rejects.toThrow("Invalid repository identity.");
      expect(calls).toEqual([]);
    },
  );

  it.each(["1/../../x", "0", "-1", "1.5", "1e3", " 12", "0x10", "12abc", "", "NaN"])(
    "refuses GITHUB_RUN_ID %j before any request",
    async (runId) => {
      for (const mode of REFUSES_BEFORE_ANY_REQUEST) {
        const calls: string[] = [];
        await expect(
          scenario({ mode, calls, envOverride: { GITHUB_RUN_ID: runId } }),
        ).rejects.toThrow("Invalid GitHub run identity.");
        expect(calls).toEqual([]);
      }
    },
  );

  it.each(["1/../../x", "0", "-1", "1.5", "abc", ""])(
    "refuses GITHUB_RUN_ATTEMPT %j before any request",
    async (attempt) => {
      const calls: string[] = [];
      await expect(
        scenario({ calls, envOverride: { GITHUB_RUN_ATTEMPT: attempt } }),
      ).rejects.toThrow("Invalid GitHub run identity.");
      expect(calls).toEqual([]);
    },
  );

  it.each<[string, unknown]>([
    ["traversal string", "1/../../x"],
    ["fraction", 1.5],
    ["zero", 0],
    ["negative", -3],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ["numeric string", "42"],
  ])("refuses a PR number that is a %s before any request", async (_label, number) => {
    const calls: string[] = [];
    await expect(
      scenario({ calls, prPatch: { number } }),
    ).rejects.toThrow("Exact triggering PR identity unavailable.");
    expect(calls).toEqual([]);
  });

  it.each(["a/../../x", "A".repeat(40), "a".repeat(39), "a".repeat(41)])(
    "refuses a head SHA %j before any request",
    async (badSha) => {
      const calls: string[] = [];
      await expect(
        scenario({ calls, prPatch: { head: { sha: badSha } } }),
      ).rejects.toThrow("Exact triggering PR identity unavailable.");
      expect(calls).toEqual([]);
    },
  );

  it("never lets an API response id steer a request off its route", async () => {
    // A same-name record whose id carries a traversal. It is the only route
    // segment that originates in a response body rather than in validated input.
    const calls: string[] = [];
    await expect(
      scenario({ calls, forged: true, forgedId: "99/../../../x" }),
    ).rejects.toThrow("Invalid GitHub API route.");
    expect(calls.filter((url) => url.includes(".."))).toEqual([]);
    expect(calls.filter((url) => /\/check-runs\/[^/?]*[^0-9/?]/.test(url))).toEqual([]);
  });

  it("sends every request to the allowlisted origin and the validated repository", async () => {
    const calls: string[] = [];
    await scenario({
      mode: "finish",
      files: ["app/page.tsx"],
      calls,
      envOverride: { GITHUB_API_URL: "https://api.github.com/" },
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls)
      expect(url.startsWith("https://api.github.com/repos/aalzriqat/Auto/")).toBe(true);
  });
});
