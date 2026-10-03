/**
 * SCRUM-565 D-17 (N9) / D-19 — the release preflight fails CLOSED.
 *
 * The runner is injected, so no Convex CLI is spawned. PASS requires every page
 * read, the live backend attesting the D-19 no-new-start barrier, the deployment
 * confirming its own identity, and a zero total; everything else is a refusal
 * that prints no org data.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PREFLIGHT_FN, PREFLIGHT_PROTOCOL, renderOutcome, runResetPreflight } from "./resetInProgressPreflight.mjs";
import * as queryModule from "../convex/orgResetPreflight";

const DEPLOYMENT = "kindly-hound-172";
const KEY = `prod:${DEPLOYMENT}|secretpart`;
const URL_OK = `https://${DEPLOYMENT}.convex.cloud`;

type Page = Record<string, unknown>;
const good = (over: Page = {}): Page => ({
  protocol: PREFLIGHT_PROTOCOL,
  freshStartsBlocked: true,
  deploymentUrl: URL_OK,
  scanned: 3,
  inProgress: 0,
  isDone: true,
  continueCursor: "end",
  ...over,
});

function walk(pages: Array<Page | { ok: false; reason: string }>, extra: Record<string, unknown> = {}) {
  let i = 0;
  const calls: string[] = [];
  const outcome = runResetPreflight({
    run: (args: string) => {
      calls.push(args);
      const next = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return "ok" in next && next.ok === false ? next : { ok: true, value: next };
    },
    deployKey: KEY,
    expectedDeployment: DEPLOYMENT,
    ...extra,
  });
  return { outcome, calls };
}

const reasonOf = (outcome: { ok: boolean }) => (outcome as { reason: string }).reason;

describe("runResetPreflight", () => {
  test("passes on an all-zero multi-page walk and totals the pages", () => {
    const { outcome, calls } = walk([
      good({ isDone: false, continueCursor: "c1" }),
      good({ isDone: false, continueCursor: "c2", scanned: 5 }),
      good({ scanned: 2 }),
    ]);
    expect(outcome).toEqual({ ok: true, scanned: 10, inProgress: 0 });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[1]).paginationOpts.cursor).toBe("c1");
  });

  test("fails on a positive count, even on a later page", () => {
    const { outcome } = walk([good({ isDone: false, continueCursor: "c1" }), good({ inProgress: 1 })]);
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).toMatch(/1 organization\(s\) are mid financial reset/);
  });

  test("fails on a CLI error", () => {
    expect(walk([{ ok: false, reason: "cli failed" }]).outcome.ok).toBe(false);
  });

  test("fails on a malformed answer", () => {
    for (const bad of [null, [], "x", 5]) {
      const outcome = runResetPreflight({
        run: () => ({ ok: true, value: bad }),
        deployKey: KEY,
        expectedDeployment: DEPLOYMENT,
      });
      expect(outcome.ok, String(bad)).toBe(false);
    }
  });

  test("fails on a wrong or missing protocol, including the superseded v1", () => {
    expect(walk([good({ protocol: "other" })]).outcome.ok).toBe(false);
    expect(walk([good({ protocol: undefined })]).outcome.ok).toBe(false);
    const v1 = walk([good({ protocol: "SCRUM-565/N9/v1" })]).outcome;
    expect(v1.ok).toBe(false);
    expect(reasonOf(v1)).toMatch(/protocol/i);
  });

  test("fails on invalid counts", () => {
    for (const over of [{ scanned: -1 }, { inProgress: 1.5 }, { scanned: "3" }, { inProgress: 4, scanned: 3 }, { isDone: "yes" }]) {
      expect(walk([good(over)]).outcome.ok, JSON.stringify(over)).toBe(false);
    }
  });

  test("fails when the cursor does not advance", () => {
    const stuck = good({ isDone: false, continueCursor: "same" });
    const { outcome } = walk([stuck, stuck]);
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).toMatch(/cursor stopped advancing/);
  });

  test("fails when an EARLIER cursor repeats (A -> B -> A), not only the previous one", () => {
    const { outcome, calls } = walk([
      good({ isDone: false, continueCursor: "A" }),
      good({ isDone: false, continueCursor: "B" }),
      good({ isDone: false, continueCursor: "A" }),
      good({ isDone: false, continueCursor: "C" }),
    ]);
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).toMatch(/cursor stopped advancing/);
    // It refused at the repeat; it did not keep walking.
    expect(calls).toHaveLength(3);
  });

  test("fails when the page cap is reached", () => {
    let n = 0;
    const outcome = runResetPreflight({
      run: () => ({ ok: true, value: good({ isDone: false, continueCursor: `c${(n += 1)}` }) }),
      deployKey: KEY,
      expectedDeployment: DEPLOYMENT,
      maxPages: 5,
    });
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).toMatch(/within 5 pages/);
    expect(n).toBe(5);
  });

  test("fails on a key for the wrong deployment without calling the runner", () => {
    let called = false;
    const outcome = runResetPreflight({
      run: () => {
        called = true;
        return { ok: true, value: good() };
      },
      deployKey: "prod:some-other-deployment|secretpart",
      expectedDeployment: DEPLOYMENT,
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("secretpart");
  });

  test("names the key an operator key (the key the workflow passes as CONVEX_DEPLOY_KEY)", () => {
    const outcome = runResetPreflight({
      run: () => ({ ok: true, value: good() }),
      deployKey: "prod:some-other-deployment|secretpart",
      expectedDeployment: DEPLOYMENT,
    });
    expect(reasonOf(outcome)).toMatch(/operator key/);
    expect(reasonOf(outcome)).not.toMatch(/deploy key/);
  });

  test("fails on a missing key or expected deployment", () => {
    expect(runResetPreflight({ run: () => ({ ok: true, value: good() }), deployKey: undefined, expectedDeployment: DEPLOYMENT }).ok).toBe(false);
    expect(runResetPreflight({ run: () => ({ ok: true, value: good() }), deployKey: KEY, expectedDeployment: "" }).ok).toBe(false);
  });

  test("output never contains an org id even if the backend sent one", () => {
    const { outcome } = walk([good({ inProgress: 1, orgId: "jx7abc0org", orgName: "Secret Dealer" })]);
    expect(JSON.stringify(outcome)).not.toMatch(/jx7abc0org|Secret Dealer/);
  });

  // main() prints exactly renderOutcome(outcome), so this is the printed text.
  test("rendered output (refusal and success) carries no org id or name", () => {
    const leaky = { orgId: "jx7abc0org", orgName: "Secret Dealer" };
    const refusal = walk([good({ inProgress: 1, ...leaky })]).outcome;
    const success = walk([good({ ...leaky })]).outcome;
    expect(refusal.ok).toBe(false);
    expect(success.ok).toBe(true);
    for (const text of [renderOutcome(refusal), renderOutcome(success)]) {
      expect(text).not.toMatch(/jx7abc0org|Secret Dealer/);
    }
    expect(renderOutcome(success)).toContain("scanned 3, in progress 0");
  });
});

describe("D-19 attestation (runResetPreflight)", () => {
  test("rejects a page that does not attest freshStartsBlocked === true", () => {
    for (const over of [{ freshStartsBlocked: undefined }, { freshStartsBlocked: false }, { freshStartsBlocked: "true" }, { freshStartsBlocked: 1 }, { freshStartsBlocked: null }]) {
      const { outcome } = walk([good(over)]);
      expect(outcome.ok, JSON.stringify(over)).toBe(false);
      expect(reasonOf(outcome), JSON.stringify(over)).toMatch(/does not attest/);
    }
  });

  test("rejects an unattested page that appears later in the walk", () => {
    const { outcome } = walk([good({ isDone: false, continueCursor: "c1" }), good({ freshStartsBlocked: false })]);
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).toMatch(/does not attest/);
  });

  test("rejects a null, missing or wrong deploymentUrl on page 1", () => {
    for (const deploymentUrl of [null, undefined, "", "https://some-other-deployment-1.convex.cloud", "not a url"]) {
      const { outcome } = walk([good({ deploymentUrl })]);
      expect(outcome.ok, String(deploymentUrl)).toBe(false);
    }
  });

  test("confirms the deployment identity on the FIRST page, before trusting any count", () => {
    const { outcome, calls } = walk([
      good({ deploymentUrl: "https://some-other-deployment-1.convex.cloud", isDone: false, continueCursor: "c1" }),
      good(),
    ]);
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("rejects a terminal page whose continueCursor is not a string", () => {
    for (const continueCursor of [undefined, null, 5, {}]) {
      const { outcome } = walk([good({ continueCursor })]);
      expect(outcome.ok, String(continueCursor)).toBe(false);
    }
  });

  test("accepts a terminal page with an empty-string continueCursor", () => {
    expect(walk([good({ continueCursor: "" })]).outcome.ok).toBe(true);
  });
});

describe("pin between the release script and the deployed query", () => {
  test("the script's protocol literal equals the query module's", () => {
    expect(PREFLIGHT_PROTOCOL).toBe(queryModule.RESET_PREFLIGHT_PROTOCOL);
    expect(PREFLIGHT_PROTOCOL).toBe("SCRUM-565/N9/v2");
  });

  test("PREFLIGHT_FN names the module and the exported query", () => {
    const [moduleName, exportName] = PREFLIGHT_FN.split(":");
    expect(moduleName).toBe("orgResetPreflight");
    expect(Object.keys(queryModule)).toContain(exportName);
    expect(exportName).toBe("countOrgsWithResetInProgress");
  });
});

// L3 — what the process itself does and prints, not just the pure function.
describe("entrypoint and CLI wrapper (L3)", () => {
  // vitest runs from the repository root (import.meta.url is not a file: URL here).
  const REPO_ROOT = process.cwd();
  const SCRIPT = path.join(REPO_ROOT, "scripts", "resetInProgressPreflight.mjs");

  function runScript(env: Record<string, string>) {
    const base: Record<string, string> = {};
    for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const value = process.env[name];
      if (value !== undefined) base[name] = value;
    }
    return spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, env: { ...base, ...env }, encoding: "utf8", timeout: 60_000 });
  }

  test("with no key it exits 1 with a refusal and prints no secret-like value", () => {
    const result = runScript({ CONVEX_PROD_DEPLOYMENT: DEPLOYMENT });
    expect(result.status).toBe(1);
    const printed = `${result.stdout}${result.stderr}`;
    expect(printed).toMatch(/✖/);
    expect(printed).not.toMatch(/secretpart|prod:[a-z0-9-]+\|/);
  });

  test("a key for the wrong deployment exits 1 and never echoes the key", () => {
    const result = runScript({
      CONVEX_PROD_DEPLOYMENT: DEPLOYMENT,
      CONVEX_DEPLOY_KEY: "prod:some-other-deployment|secretpart",
    });
    expect(result.status).toBe(1);
    const printed = `${result.stdout}${result.stderr}`;
    expect(printed).toMatch(/operator key/);
    expect(printed).not.toContain("secretpart");
  });

  test("the CLI wrapper never interpolates stdout or stderr into a reason", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/\bstderr\b/);
    const stdoutUses = code.match(/[^\n]*\bstdout\b[^\n]*/g) ?? [];
    expect(stdoutUses).toHaveLength(1);
    expect(stdoutUses[0]).toMatch(/parseConvexRunJson\(result\.stdout/);
    // Failure text comes from helpers that cannot be handed the CLI's output.
    expect(code).toMatch(/describeConvexFailure\("run", result\.status\)/);
  });

  test("the missing-CLI path is rendered through renderOutcome, not a raw console.error of a path", () => {
    const code = readFileSync(SCRIPT, "utf8");
    expect(code).not.toMatch(/console\.error\(`[^`]*\$\{CONVEX_CLI\}/);
  });
});
