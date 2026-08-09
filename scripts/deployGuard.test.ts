import { describe, expect, test } from "vitest";
import {
  ALLOWED_DEPLOY_ARGS,
  bundleOffenders,
  describeTargetSelection,
  evaluateProdDeploy,
  extractDeploymentName,
  looksLikeProduction,
  type RepoSnapshot,
} from "./deployGuard";

/**
 * Each case is a state that actually reached production, a bypass reproduced
 * against this guard, or the exact condition that would have stopped either.
 *
 * The incident: `CONVEX_DEPLOYMENT=dev:vibrant-cat-418 npx convex deploy -y`
 * pushed unmerged code plus an untracked scratch module to prod. `-y` (an
 * undocumented flag) suppressed the confirmation naming the production
 * deployment; the untracked file was bundled from disk and so appeared in no
 * diff, review or CI check.
 */

const CLEAN: RepoSnapshot = {
  branch: "main",
  headSha: "284e3e35e171313620c94f29a377c2ff6e1f4f78",
  originMainSha: "284e3e35e171313620c94f29a377c2ff6e1f4f78",
  headIsAncestorOfOriginMain: true,
  trackedChanges: [],
  bundleFilesOnDisk: ["convex/schema.ts", "convex/socialInbox.ts"],
  trackedBundleFiles: ["convex/schema.ts", "convex/socialInbox.ts"],
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
    const snapshot = {
      ...CLEAN,
      bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/probe211.ts"],
    };
    expect(failureIds(snapshot)).toContain("bundle-is-tracked");
    const failure = evaluateProdDeploy(snapshot).failures.find(
      (f) => f.id === "bundle-is-tracked"
    );
    // Naming the file matters; "something is untracked" sends the operator
    // hunting through git status for it.
    expect(failure?.detail).toContain("convex/probe211.ts");
  });

  test("a .gitignored module under convex/ is refused too", () => {
    // Reproduced against this repo: `.gitignore` carries an unanchored
    // `fix_*.js`, so `convex/fix_probe.js` is invisible to `git status
    // --porcelain` — the guard's original question — while Convex still bundles
    // it off disk. Strictly more invisible than the file that caused the
    // incident, because even `git status` stays silent.
    expect(
      failureIds({
        ...CLEAN,
        bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/fix_probe.js"],
      })
    ).toContain("bundle-is-tracked");
  });

  test("non-ASCII filenames are compared as-is, not through porcelain quoting", () => {
    // git quotes these in --porcelain=v1 as "conv\303\251x/x.ts", which broke a
    // convex/ prefix test and mangled the name in the message.
    expect(
      failureIds({
        ...CLEAN,
        bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/probé.ts"],
      })
    ).toContain("bundle-is-tracked");
  });

  test("a tracked bundle file is not an offender", () => {
    expect(evaluateProdDeploy(CLEAN).ok).toBe(true);
  });

  test.each(["-y", "--yes", "-vy", "-yv", "--yes=true", "--force", "-f", "--no-verify"])(
    "%s is refused",
    (flag) => {
      // `-vy` is the one that matters: commander expands combined short flags,
      // so it sets verbose AND yes while matching neither `-y` nor `--yes`
      // exactly. An exact-match denylist passed it, which is why this is an
      // allowlist.
      expect(failureIds({ ...CLEAN, forwardedArgs: [flag] })).toContain("allowed-args-only");
    }
  );

  test("known-safe flags and their values still pass through", () => {
    expect(
      evaluateProdDeploy({
        ...CLEAN,
        forwardedArgs: ["--typecheck", "disable", "-v", "--cmd", "pnpm build"],
      }).ok
    ).toBe(true);
  });

  test("a flag value is never mistaken for a flag", () => {
    // `--cmd "npx convex deploy -y"` would be alarming, but the value belongs to
    // --cmd; what matters is that a bare `-y` in flag position is still caught.
    expect(
      evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--cmd", "pnpm build", "-y"] }).ok
    ).toBe(false);
  });

  test("the allowlist does not quietly contain an auto-confirm flag", () => {
    for (const flag of ALLOWED_DEPLOY_ARGS) {
      expect(flag).not.toMatch(/^-[a-z]*y$/i);
      expect(flag).not.toBe("--yes");
    }
  });

  test("uncommitted tracked changes are refused", () => {
    expect(
      failureIds({ ...CLEAN, trackedChanges: ["convex/schema.ts", "convex/socialInbox.ts"] })
    ).toContain("clean-worktree");
  });

  test("unmerged code is refused", () => {
    expect(
      failureIds({
        ...CLEAN,
        branch: "agent/convex-io-conversations",
        headSha: "ba939af6".padEnd(40, "0"),
        headIsAncestorOfOriginMain: false,
      })
    ).toContain("merged-into-main");
  });

  test("a diverged branch is not called 'behind', and is not offered --allow-behind", () => {
    const diverged: RepoSnapshot = {
      ...CLEAN,
      branch: "agent/deploy-target-guard",
      headSha: "0c57293e".padEnd(40, "0"),
      headIsAncestorOfOriginMain: false,
    };
    const tip = evaluateProdDeploy(diverged).checks.find((c) => c.id === "at-origin-main-tip");
    expect(tip?.detail).toMatch(/diverged/);
    expect(tip?.detail).not.toMatch(/pass --allow-behind/);
    // And --allow-behind must not launder unmerged code into a deploy.
    expect(evaluateProdDeploy(diverged, { allowBehind: true }).ok).toBe(false);
  });

  test("a merged commit behind the tip needs --allow-behind", () => {
    const behind: RepoSnapshot = {
      ...CLEAN,
      headSha: "52be7b4f".padEnd(40, "0"),
      headIsAncestorOfOriginMain: true,
    };
    expect(failureIds(behind)).toContain("at-origin-main-tip");
    expect(evaluateProdDeploy(behind, { allowBehind: true }).ok).toBe(true);
  });

  test("--allow-behind excuses only the tip check", () => {
    const ids = failureIds(
      {
        ...CLEAN,
        headSha: "52be7b4f".padEnd(40, "0"),
        bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/probe211.ts"],
        trackedChanges: ["convex/schema.ts"],
      },
      { allowBehind: true }
    );
    expect(ids).toContain("bundle-is-tracked");
    expect(ids).toContain("clean-worktree");
    expect(ids).not.toContain("at-origin-main-tip");
  });

  test("there is no override flag — a --force is itself refused", () => {
    // Deliberately otherwise-clean, so the refusal is attributable to the flag
    // rather than to some other failure in the fixture.
    const result = evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--force"] });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.id)).toEqual(["allowed-args-only"]);
  });

  test("every failure is reported at once, not one per attempt", () => {
    const ids = failureIds({
      branch: "agent/convex-io-conversations",
      headSha: "ba939af6".padEnd(40, "0"),
      originMainSha: "284e3e35".padEnd(40, "0"),
      headIsAncestorOfOriginMain: false,
      trackedChanges: ["convex/schema.ts"],
      bundleFilesOnDisk: ["convex/probe211.ts"],
      trackedBundleFiles: [],
      forwardedArgs: ["-y"],
      env: { CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" },
    });
    expect(ids).toEqual(
      expect.arrayContaining([
        "allowed-args-only",
        "bundle-is-tracked",
        "clean-worktree",
        "merged-into-main",
        "at-origin-main-tip",
      ])
    );
  });
});

describe("bundleOffenders", () => {
  test("reports on-disk files that git does not track", () => {
    expect(
      bundleOffenders(["convex/a.ts", "convex/fix_probe.js"], ["convex/a.ts"])
    ).toEqual(["convex/fix_probe.js"]);
  });

  test("a tracked file deleted from disk is not an offender", () => {
    // Deleting a file is the clean-worktree check's business, not the bundle's.
    expect(bundleOffenders(["convex/a.ts"], ["convex/a.ts", "convex/gone.ts"])).toEqual([]);
  });

  test("separators are normalised on both sides before comparison", () => {
    expect(bundleOffenders(["convex\\utils\\a.ts"], ["convex/utils/a.ts"])).toEqual([]);
  });

  test("an empty tracked list makes every on-disk file an offender", () => {
    expect(bundleOffenders(["convex/a.ts", "convex/b.ts"], [])).toEqual([
      "convex/a.ts",
      "convex/b.ts",
    ]);
  });
});

describe("reading the target back out of the dry run", () => {
  const REAL_DRY_RUN = [
    "▌ Deploying code to deployment:",
    "▌ [Production] aalzriqat:auto:production (prod) (dashboard: https://dashboard.convex.dev/t/aalzriqat/auto/kindly-hound-172)",
    "▌ └─ https://kindly-hound-172.convex.cloud",
    "- Deploying to https://kindly-hound-172.convex.cloud... [dry run]",
  ].join("\n");

  test("the deployment name comes from the CLI's own announcement", () => {
    // Read back rather than inferred from CONVEX_DEPLOYMENT, because inferring
    // the target from that variable is the mistake that caused the incident.
    expect(extractDeploymentName(REAL_DRY_RUN)).toBe("kindly-hound-172");
  });

  test("production is recognised from the announcement", () => {
    expect(looksLikeProduction(REAL_DRY_RUN)).toBe(true);
    expect(looksLikeProduction("▌ [Preview] some-preview-123")).toBe(false);
  });

  test("output with no target line yields null so the caller can refuse", () => {
    // A confirmation that cannot name the target is not a confirmation.
    expect(extractDeploymentName("some unrelated error")).toBeNull();
  });

  test("the dashboard URL is a fallback when the cloud URL is absent", () => {
    expect(
      extractDeploymentName("(dashboard: https://dashboard.convex.dev/t/a/auto/vibrant-cat-418)")
    ).toBe("vibrant-cat-418");
  });
});

describe("target selection is described, not inferred", () => {
  test("a dev CONVEX_DEPLOYMENT is called out as NOT redirecting the deploy", () => {
    const text = describeTargetSelection({ CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" });
    expect(text).toContain("dev:vibrant-cat-418");
    expect(text).toMatch(/does NOT redirect/i);
    expect(text).toMatch(/PRODUCTION/i);
  });

  test("a prod CONVEX_DEPLOYMENT is called out as silencing the prompt", () => {
    // Verified with --dry-run: when the configured deployment IS the target,
    // Convex asks nothing at all.
    expect(describeTargetSelection({ CONVEX_DEPLOYMENT: "prod:kindly-hound-172" })).toMatch(
      /will NOT prompt/i
    );
  });

  test("a deploy key is called out as silencing the prompt", () => {
    expect(describeTargetSelection({ CONVEX_DEPLOY_KEY: "prod:xxx" })).toMatch(/will NOT prompt/i);
  });

  test("the source of the value is reported when it came from a file", () => {
    // The CLI reads .env.local and .env itself, so a key can be in force
    // without appearing in process.env.
    expect(
      describeTargetSelection({ CONVEX_DEPLOY_KEY: "prod:xxx", source: ".env.local" })
    ).toContain(".env.local");
  });

  test("an unset environment is described as refusing, not as defaulting", () => {
    // Verified: with neither set the CLI errors rather than guessing.
    expect(describeTargetSelection({})).toMatch(/refuse/i);
  });
});
