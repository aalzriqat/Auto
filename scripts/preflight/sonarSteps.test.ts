// @vitest-environment node
// SCRUM-1011: the `sonar-lint` and `inventories` preflight steps, driven through the shared fake-tool harness.
import { describe, expect, it } from "vitest";
import { byId, run, type RunOutcome } from "./preflightHarness";

/** One ESLint `--format json` document, as the sonar-lint step reads it. */
const lintJson = (messages: Array<{ ruleId: string | null; severity: 1 | 2; line: number; message: string; fatal?: boolean }>, file = "/repo/lib/a.ts"): string =>
  JSON.stringify([{ filePath: file, messages: messages.map((m) => ({ column: 1, ...m })) }]);

describe("SCRUM-1011 sonar-lint step (Sonar rule classes, locally)", () => {
  const BAD = { ruleId: "sonarjs/no-alphabetical-sort", severity: 2 as const, line: 5, message: "Provide a compare function to avoid sorting elements alphabetically." };
  const SMELL = { ruleId: "sonarjs/cognitive-complexity", severity: 1 as const, line: 9, message: "Refactor this function to reduce its Cognitive Complexity from 21 to the 15 allowed." };

  it("ignores inline eslint-disable comments, as SonarCloud does", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]] });
    expect(h.calls.find((c) => c.id === "sonar-lint")?.args).toContain("--no-inline-config");
  });

  it("reads the diff with git config pinned, so a user's prefix or quoting settings cannot change what is parsed", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]] });
    const diff = h.gitCalls.find((a) => a.includes("-U0"));
    expect(diff?.slice(0, 7)).toEqual(["-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "diff"]);
  });

  it("runs eslint with the preflight config, JSON output and only the changed lintable files", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"], ["M", "README.md"], ["D", "lib/old.ts"]] });
    const call = h.calls.find((c) => c.id === "sonar-lint");
    expect(call?.args).toEqual(expect.arrayContaining(["--config", "eslint.preflight.config.mjs", "--format", "json"]));
    expect(call?.args.slice(-2)).toEqual(["--", "lib/a.ts"]);
    expect(byId(h, "sonar-lint").status).toBe("PASS");
  });

  it("is NOT APPLICABLE, with the reason, when no lintable file changed", async () => {
    const h = await run({ changed: [["M", "README.md"]] });
    expect(byId(h, "sonar-lint").status).toBe("NOT APPLICABLE");
    expect(h.calls.some((c) => c.id === "sonar-lint")).toBe(false);
  });

  it("FAILS on a bug-class error, naming the rule id, file:line and the Sonar S-number in the fix", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([BAD]) } } });
    const r = byId(h, "sonar-lint");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/sonarjs\/no-alphabetical-sort/);
    expect(r.detail).toMatch(/lib\/a\.ts:5/);
    expect(r.detail).toMatch(/S2871/);
    expect(r.fix.join("\n")).toMatch(/S2871/);
    expect(h.code).toBe(1);
  });

  it("does not fail on warnings: prints and counts them, exit 0", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 0, stdout: lintJson([SMELL]) } } });
    const r = byId(h, "sonar-lint");
    expect(r.status).toBe("PASS");
    expect(r.detail).toMatch(/1 warning/);
    expect(h.out).toMatch(/lib\/a\.ts:9/);
    expect(h.out).toMatch(/S3776/);
    expect(h.code).toBe(0);
  });

  it("an error and a warning together FAIL and still list the warning", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([BAD, SMELL]) } } });
    expect(byId(h, "sonar-lint").status).toBe("FAIL");
    expect(h.out).toMatch(/S3776/);
  });

  it("ignores messages from rules that are not Sonar rules (the eslint step owns those)", async () => {
    const other = { ruleId: "no-undef", severity: 2 as const, line: 1, message: "x is not defined" };
    const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": { status: 1, stdout: lintJson([other]) } } });
    expect(byId(h, "sonar-lint").status).toBe("PASS");
  });

  describe("new code only, like Sonar's new-code period", () => {
    const HUNKS = "diff --git a/lib/a.ts b/lib/a.ts\n--- a/lib/a.ts\n+++ b/lib/a.ts\n@@ -3,0 +4,3 @@ context\n+x\n+y\n+z\n@@ -20 +30 @@\n-old\n+new\n";
    const LEGACY = { ...BAD, line: 12 };

    it("ignores an error on a line the change did not touch (legacy code in a touched file)", async () => {
      const h = await run({ changed: [["M", "lib/a.ts"]], hunks: HUNKS, outcomes: { "sonar-lint": { status: 1, stdout: lintJson([LEGACY]) } } });
      expect(byId(h, "sonar-lint").status).toBe("PASS");
    });

    it("keeps an error inside an added hunk (lines 4-6) and one on a single changed line (30)", async () => {
      for (const line of [4, 6, 30]) {
        const h = await run({ changed: [["M", "lib/a.ts"]], hunks: HUNKS, outcomes: { "sonar-lint": { status: 1, stdout: lintJson([{ ...BAD, line }]) } } });
        expect(byId(h, "sonar-lint").status, `line ${line}`).toBe("FAIL");
      }
      for (const line of [3, 7, 29, 31]) {
        const h = await run({ changed: [["M", "lib/a.ts"]], hunks: HUNKS, outcomes: { "sonar-lint": { status: 1, stdout: lintJson([{ ...BAD, line }]) } } });
        expect(byId(h, "sonar-lint").status, `line ${line}`).toBe("PASS");
      }
    });

    it("a file with no hunks (new or untracked) is judged on every line, and so is a warning on a touched file's old lines hidden", async () => {
      const h = await run({ changed: [["M", "lib/a.ts"]], untracked: ["lib/new.ts"], hunks: HUNKS, outcomes: { "sonar-lint": { status: 1, stdout: lintJson([BAD], "/repo/lib/new.ts") } } });
      expect(byId(h, "sonar-lint").status).toBe("FAIL");
      const quiet = await run({ changed: [["M", "lib/a.ts"]], hunks: HUNKS, outcomes: { "sonar-lint": { status: 0, stdout: lintJson([{ ...SMELL, line: 12 }]) } } });
      expect(quiet.out).not.toMatch(/S3776/);
    });
  });

  it("(cannot run) a spawn error, exit 2, unparsable output or a fatal parse error is FAIL, never a pass", async () => {
    const cases: Array<[string, RunOutcome]> = [
      ["spawn", { status: null, error: new Error("spawn ENOENT") }],
      ["exit 2", { status: 2, stderr: "Error: Cannot find module 'eslint-plugin-sonarjs'" }],
      ["not json", { status: 0, stdout: "not json" }],
      ["empty", { status: 0, stdout: "" }],
      ["fatal", { status: 1, stdout: lintJson([{ ruleId: null, severity: 2, line: 1, message: "Parsing error: Unexpected token", fatal: true }]) }],
    ];
    for (const [name, outcome] of cases) {
      const h = await run({ changed: [["M", "lib/a.ts"]], outcomes: { "sonar-lint": outcome } });
      expect(byId(h, "sonar-lint").status, name).toBe("FAIL");
      expect(h.code, name).toBe(1);
    }
  });

  it("(cannot run) FAILS when the preflight config is missing", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]], existing: (p) => !/eslint\.preflight\.config/.test(p) });
    expect(byId(h, "sonar-lint").status).toBe("FAIL");
    expect(byId(h, "sonar-lint").detail).toMatch(/cannot run/i);
    expect(h.calls.some((c) => c.id === "sonar-lint")).toBe(false);
  });
});

describe("SCRUM-1011 inventories step (registration inventories that CI runs as unit tests)", () => {
  it("is NOT APPLICABLE when neither convex/ nor an inventory file changed", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]] });
    expect(byId(h, "inventories").status).toBe("NOT APPLICABLE");
    expect(h.calls.some((c) => c.id === "inventories")).toBe(false);
  });

  it("runs the globbed inventory tests with --maxWorkers=1 when convex/ changed", async () => {
    const h = await run({ changed: [["A", "convex/newModule.ts"]] });
    const call = h.calls.find((c) => c.id === "inventories");
    expect(call?.args).toEqual(expect.arrayContaining(["run", "--maxWorkers=1"]));
    const files = (call?.args ?? []).filter((a) => a.startsWith("./"));
    expect([...files].sort((a, b) => a.localeCompare(b))).toEqual([
      "./scripts/economicCommandCensus.test.ts",
      "./scripts/economicCommandCensusDomainIndex.test.ts",
      "./scripts/regression/pilotDoorInventory.test.ts",
      "./scripts/tenantWriteGuard.test.ts",
      "./scripts/tenantWriteGuardDelegation.test.ts",
    ]);
    expect(byId(h, "inventories").status).toBe("PASS");
  });

  it("also runs when an inventory test itself changed", async () => {
    const h = await run({ changed: [["M", "scripts/regression/pilotDoorInventory.test.ts"]] });
    expect(h.calls.some((c) => c.id === "inventories")).toBe(true);
  });

  it("FAILS with the failing output and the command to re-run", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { inventories: { status: 1, stdout: "FAIL tenantWriteGuard.test.ts: convex/deals.ts is not registered" } } });
    const r = byId(h, "inventories");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/not registered/);
    expect(r.fix.join("\n")).toMatch(/vitest\.mjs run --maxWorkers=1/);
  });

  it("FAILS, never skips, when the inventory tests cannot be listed or none are found", async () => {
    const boom = await run({ changed: [["M", "convex/deals.ts"]], readDir: () => { throw new Error("ENOENT scripts"); } });
    expect(byId(boom, "inventories").status).toBe("FAIL");
    expect(byId(boom, "inventories").detail).toMatch(/cannot run/i);
    const none = await run({ changed: [["M", "convex/deals.ts"]], readDir: () => [] });
    expect(byId(none, "inventories").status).toBe("FAIL");
  });

  it("FAILS when the test process cannot be spawned", async () => {
    const h = await run({ changed: [["M", "convex/deals.ts"]], outcomes: { inventories: { status: null, error: new Error("spawn ENOENT") } } });
    expect(byId(h, "inventories").status).toBe("FAIL");
  });
});
