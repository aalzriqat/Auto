import { describe, expect, test } from "vitest";
import {
  AUTO_CONFIRM_FLAGS,
  describeTargetSelection,
  evaluateProdDeploy,
  parsePorcelain,
  type RepoSnapshot,
} from "./deployGuard";

/**
 * Each case here is a state that actually reached production, or the exact
 * state that would have prevented it.
 *
 * The incident, in one line: `CONVEX_DEPLOYMENT=dev:vibrant-cat-418 npx convex
 * deploy -y` pushed unmerged code plus an untracked scratch module to prod. The
 * `-y` suppressed a prompt that names the production deployment; the untracked
 * file was bundled from disk and so appeared in no diff, review or CI check.
 */

const CLEAN: RepoSnapshot = {
  branch: "main",
  headSha: "284e3e35e171313620c94f29a377c2ff6e1f4f78",
  originMainSha: "284e3e35e171313620c94f29a377c2ff6e1f4f78",
  headIsAncestorOfOriginMain: true,
  trackedChanges: [],
  untrackedPaths: [],
  forwardedArgs: [],
  env: {},
};

const failureIds = (snapshot: RepoSnapshot, options = {}) =>
  evaluateProdDeploy(snapshot, options).failures.map((f) => f.id);

describe("production deploy preconditions", () => {
  test("a clean, merged checkout at the tip is allowed", () => {
    const result = evaluateProdDeploy(CLEAN);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("THE INCIDENT: an untracked module under convex/ is refused", () => {
    // `convex/` is bundled from disk, not from git. `probe211.ts` was untracked,
    // so it shipped to production while appearing in no diff and no review.
    const result = evaluateProdDeploy({
      ...CLEAN,
      untrackedPaths: ["convex/probe211.ts"],
    });
    expect(result.ok).toBe(false);
    expect(failureIds({ ...CLEAN, untrackedPaths: ["convex/probe211.ts"] })).toContain(
      "no-untracked-in-bundle"
    );
    // The message has to name the file; "something is untracked" sends the
    // operator hunting through `git status` for it.
    const failure = result.failures.find((f) => f.id === "no-untracked-in-bundle");
    expect(failure?.detail).toContain("convex/probe211.ts");
  });

  test("untracked files outside the bundled directory are not the deploy's problem", () => {
    // Scratch notes, local env files and spec drafts sit in every worktree here.
    // Refusing on those would train people to ignore the guard.
    expect(
      evaluateProdDeploy({
        ...CLEAN,
        untrackedPaths: ["DEAL-FINANCIALS-SPEC.md", ".env.local", "handoff.md"],
      }).ok
    ).toBe(true);
  });

  test("nested untracked paths under convex/ are caught too", () => {
    expect(
      failureIds({ ...CLEAN, untrackedPaths: ["convex/utils/scratchProbe.ts"] })
    ).toContain("no-untracked-in-bundle");
  });

  test.each(AUTO_CONFIRM_FLAGS)("%s is refused — it silences the production prompt", (flag) => {
    const snapshot = { ...CLEAN, forwardedArgs: [flag] };
    expect(failureIds(snapshot)).toContain("no-auto-confirm");
    const failure = evaluateProdDeploy(snapshot).failures.find(
      (f) => f.id === "no-auto-confirm"
    );
    expect(failure?.detail).toContain(flag);
  });

  test("ordinary forwarded flags still pass through", () => {
    expect(
      evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--typecheck", "disable", "-v"] }).ok
    ).toBe(true);
  });

  test("uncommitted tracked changes are refused", () => {
    expect(
      failureIds({ ...CLEAN, trackedChanges: ["convex/schema.ts", "convex/socialInbox.ts"] })
    ).toContain("clean-worktree");
  });

  test("unmerged code is refused", () => {
    // The state on 2026-08-07: a PR branch, not an ancestor of origin/main.
    expect(
      failureIds({
        ...CLEAN,
        branch: "agent/convex-io-conversations",
        headSha: "ba939af6".padEnd(40, "0"),
        headIsAncestorOfOriginMain: false,
      })
    ).toContain("merged-into-main");
  });

  test("a merged commit behind the tip needs --allow-behind", () => {
    const behind: RepoSnapshot = {
      ...CLEAN,
      headSha: "52be7b4f".padEnd(40, "0"),
      headIsAncestorOfOriginMain: true,
    };
    // This is the rollback shape — redeploying an older merged commit. It is a
    // legitimate operation and must stay possible, but never by accident.
    expect(failureIds(behind)).toContain("at-origin-main-tip");
    expect(evaluateProdDeploy(behind, { allowBehind: true }).ok).toBe(true);
  });

  test("--allow-behind does not excuse anything else", () => {
    // A rollback still may not carry an untracked bundle file or a dirty tree.
    const ids = failureIds(
      {
        ...CLEAN,
        headSha: "52be7b4f".padEnd(40, "0"),
        untrackedPaths: ["convex/probe211.ts"],
        trackedChanges: ["convex/schema.ts"],
      },
      { allowBehind: true }
    );
    expect(ids).toContain("no-untracked-in-bundle");
    expect(ids).toContain("clean-worktree");
    expect(ids).not.toContain("at-origin-main-tip");
  });

  test("every failure is reported at once, not one per attempt", () => {
    // Four things wrong; the operator should learn all four now rather than
    // rerun the guard four times.
    const ids = failureIds({
      branch: "agent/convex-io-conversations",
      headSha: "ba939af6".padEnd(40, "0"),
      originMainSha: "284e3e35".padEnd(40, "0"),
      headIsAncestorOfOriginMain: false,
      trackedChanges: ["convex/schema.ts"],
      untrackedPaths: ["convex/probe211.ts"],
      forwardedArgs: ["-y"],
      env: { CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" },
    });
    expect(ids).toEqual(
      expect.arrayContaining([
        "no-auto-confirm",
        "no-untracked-in-bundle",
        "clean-worktree",
        "merged-into-main",
        "at-origin-main-tip",
      ])
    );
  });

  test("there is no override flag", () => {
    // Every check has a cheap honest resolution. A --force would be reached for
    // by habit, and this guard exists because a habit is what caused the
    // incident.
    const snapshot = {
      ...CLEAN,
      untrackedPaths: ["convex/probe211.ts"],
      forwardedArgs: ["--force", "-f", "--no-verify"],
    };
    expect(evaluateProdDeploy(snapshot).ok).toBe(false);
  });
});

describe("porcelain parsing", () => {
  test("a leading space is not eaten — the reported path is the real path", () => {
    // The bug this pins: the first version trimmed the git command's whole
    // output, which removed the leading space that porcelain uses for
    // "unstaged". `slice(3)` then cut one character into the name and the guard
    // announced "ackage.json". A guard whose message names the wrong file sends
    // the operator looking for something that is not there.
    const raw = " M package.json\n?? convex/probeScratch.ts";
    const { trackedChanges, untrackedPaths } = parsePorcelain(raw);
    expect(trackedChanges).toEqual(["package.json"]);
    expect(untrackedPaths).toEqual(["convex/probeScratch.ts"]);
  });

  test.each([
    [" M convex/schema.ts", "convex/schema.ts"],
    ["M  convex/schema.ts", "convex/schema.ts"],
    ["MM convex/schema.ts", "convex/schema.ts"],
    ["A  convex/new.ts", "convex/new.ts"],
    ["D  convex/gone.ts", "convex/gone.ts"],
  ])("%s is read as a tracked change to %s", (line, expected) => {
    expect(parsePorcelain(line).trackedChanges).toEqual([expected]);
  });

  test("a rename reports the destination, which is what would deploy", () => {
    expect(
      parsePorcelain("R  convex/old.ts -> convex/new.ts").trackedChanges
    ).toEqual(["convex/new.ts"]);
  });

  test("windows separators are normalised so the convex/ prefix still matches", () => {
    const { untrackedPaths } = parsePorcelain("?? convex\\utils\\scratch.ts");
    expect(untrackedPaths).toEqual(["convex/utils/scratch.ts"]);
    expect(
      evaluateProdDeploy({ ...CLEAN, untrackedPaths }).failures.map((f) => f.id)
    ).toContain("no-untracked-in-bundle");
  });

  test("empty output is a clean tree", () => {
    expect(parsePorcelain("")).toEqual({ trackedChanges: [], untrackedPaths: [] });
  });
});

describe("target selection is described, not inferred", () => {
  test("a dev CONVEX_DEPLOYMENT is called out as NOT redirecting the deploy", () => {
    // The precise misreading behind the incident: this looks like a dev target.
    const text = describeTargetSelection({ CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" });
    expect(text).toContain("dev:vibrant-cat-418");
    expect(text).toMatch(/does NOT redirect/i);
    expect(text).toMatch(/PRODUCTION/i);
  });

  test("a deploy key is described as the CI shape", () => {
    expect(describeTargetSelection({ CONVEX_DEPLOY_KEY: "prod:xxx" })).toMatch(
      /CONVEX_DEPLOY_KEY/
    );
  });

  test("an unset environment still resolves to production", () => {
    expect(describeTargetSelection({})).toMatch(/production/i);
  });
});
