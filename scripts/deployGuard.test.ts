import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import {
  ALLOWED_DEPLOY_ARGS,
  bundleOffenders,
  describeTargetSelection,
  evaluateProdDeploy,
  extractDeploymentName,
  looksLikeProduction,
  runGuardedDeploy,
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
        forwardedArgs: ["--typecheck", "disable", "-v", "--message", "release"],
      }).ok
    ).toBe(true);
  });

  test.each(["--cmd", "--cmd-url-env-var-name"])(
    "%s is refused — it runs before the bundle is read, undoing every check",
    (flag) => {
      // From the CLI's own help: step 1 runs --cmd, step 4 bundles. Every
      // precondition here runs before the CLI is spawned at all, so an allowed
      // --cmd could write convex/anything.ts after the final validation and
      // have it shipped — the untracked-module failure this guard exists to
      // prevent, reintroduced through a flag the guard permitted. An earlier
      // version of this suite asserted --cmd passed.
      expect(failureIds({ ...CLEAN, forwardedArgs: [flag, "pnpm build"] })).toContain(
        "allowed-args-only"
      );
    }
  );

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

describe("the enforcement flow", () => {
  const DRY_OUTPUT = [
    "▌ [Production] aalzriqat:auto:production (prod)",
    "▌ └─ https://kindly-hound-172.convex.cloud",
  ].join("\n");

  /** A flow whose every side effect is observable. */
  function harness(overrides: Partial<Parameters<typeof runGuardedDeploy>[0]> = {}) {
    const deployCalls: string[][] = [];
    const dryCalls: string[][] = [];
    const io = {
      collectSnapshot: () => CLEAN,
      runDryRun: (args: string[]) => {
        dryCalls.push(args);
        return { status: 0, output: DRY_OUTPUT };
      },
      runDeploy: (args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
      ...overrides,
    };
    return { io, deployCalls, dryCalls };
  }

  test("the happy path deploys, and the real argv carries no confirmation bypass", async () => {
    const { io, deployCalls, dryCalls } = harness();
    expect(await runGuardedDeploy(io)).toBe(0);
    expect(deployCalls).toHaveLength(1);
    // The two flags that make the dry run non-interactive must never reach the
    // real deploy — that is the whole separation.
    expect(deployCalls[0]).not.toContain("-y");
    expect(deployCalls[0]).not.toContain("--dry-run");
    expect(deployCalls[0]).not.toContain("--allow-deleting-large-indexes");
    // …and the dry run must carry them, or it dead-ends on an index deletion.
    expect(dryCalls[0]).toEqual(
      expect.arrayContaining(["--dry-run", "-y", "--allow-deleting-large-indexes"])
    );
  });

  test("no TTY refuses without deploying", async () => {
    const { io, deployCalls } = harness({ isTTY: false });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("an unreadable target refuses without deploying", async () => {
    const { io, deployCalls } = harness({
      runDryRun: () => ({ status: 0, output: "no target here" }),
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("a wrong typed name refuses without deploying", async () => {
    const { io, deployCalls } = harness({ prompt: async () => "vibrant-cat-418" });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("the comparison is exact — a prefix of the target is not enough", async () => {
    const { io, deployCalls } = harness({ prompt: async () => "kindly-hound" });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("a failed dry run refuses without deploying", async () => {
    const { io, deployCalls } = harness({
      runDryRun: () => ({ status: 1, output: "", errorMessage: "spawn EINVAL" }),
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("failing preconditions refuse before the dry run even runs", async () => {
    const { io, deployCalls, dryCalls } = harness({
      collectSnapshot: () => ({ ...CLEAN, forwardedArgs: ["-vy"] }),
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(dryCalls).toEqual([]);
    expect(deployCalls).toEqual([]);
  });

  test("a tree that changes during confirmation refuses after the human said yes", async () => {
    // The bundle is read from disk at push time, not at check time, so a file
    // created during the pause would otherwise ship unexamined.
    let call = 0;
    const { io, deployCalls } = harness({
      collectSnapshot: () => {
        call += 1;
        return call === 1
          ? CLEAN
          : { ...CLEAN, bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/late.ts"] };
      },
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
  });

  test("the deploy's exit code is propagated, not swallowed", async () => {
    const { io } = harness({ runDeploy: () => 17 });
    expect(await runGuardedDeploy(io)).toBe(17);
  });
});

describe("declared Node range matches what CI actually runs", () => {
  test("engines.node does not admit a major CI never tests", () => {
    // This field is new on this branch, and nothing else in the repo pins Node
    // — no vercel.json, no .nvmrc. Vercel resolves the BUILD runtime from
    // engines.node in preference to its dashboard setting, choosing the newest
    // major the range admits. An open ">=22.18" would therefore let the
    // production web build drift onto a Node major that no CI job has ever run,
    // as a side effect of a local deploy script's type-stripping requirement.
    const pkg = JSON.parse(
      readFileSync(nodePath.join(process.cwd(), "package.json"), "utf8")
    ) as { engines?: { node?: string } };
    const range = pkg.engines?.node ?? "";
    expect(range).toMatch(/<\s*\d+/); // must have an upper bound at all

    const upper = Number(range.match(/<\s*(\d+)/)?.[1]);
    const ciMajor = Number(
      readFileSync(nodePath.join(process.cwd(), ".github", "workflows", "test.yml"), "utf8")
        .match(/node-version:\s*'?(\d+)/)?.[1]
    );
    expect(Number.isFinite(upper)).toBe(true);
    expect(Number.isFinite(ciMajor)).toBe(true);
    // The range may not reach past the major CI exercises.
    expect(upper).toBe(ciMajor + 1);
  });
});

describe("flag values that look like flags", () => {
  test("--message -y is refused, and for the right reason", () => {
    // Not a live bypass — commander binds `-y` as --cmd's argument rather than
    // as auto-confirm — but a rule that reads like one must not rest on
    // inspection. Before this, the value was skipped unconditionally.
    const result = evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--message", "-y"] });
    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.id === "allowed-args-only");
    expect(failure?.detail).toMatch(/value looks like a flag/);
    // And it must NOT claim --message is disallowed; --message is allowlisted.
    expect(failure?.detail).not.toMatch(/refusing --message —/);
  });

  test("--message is forwardable, and its ordinary value is not mistaken for a flag", () => {
    // Convex writes it to the deployment audit log. Long form only: the CLI
    // registers no `-m`, so advertising one would fail the dry run.
    expect(
      evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--message", "rollback to 52be7b4f"] }).ok
    ).toBe(true);
    expect(ALLOWED_DEPLOY_ARGS.has("-m")).toBe(false);
  });
});

describe("the target is frozen between confirmation and push", () => {
  const prod = (name: string) =>
    `▌ [Production] aalzriqat:auto:production (prod)
▌ └─ https://${name}.convex.cloud`;

  test("a target that changes after confirmation must not deploy", () => {
    // The real deploy is a separate CLI process that resolves its own target,
    // and none of the preconditions reads the environment — so confirming a
    // name guaranteed nothing about where the push landed.
    const deployCalls: string[][] = [];
    let resolution = 0;
    const io = {
      collectSnapshot: () => CLEAN,
      runDryRun: () => {
        resolution += 1;
        // First resolution: the name the operator is shown and confirms.
        // Second: something changed underneath.
        return { status: 0, output: prod(resolution === 1 ? "kindly-hound-172" : "vibrant-cat-418") };
      },
      runDeploy: (args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
    };
    return runGuardedDeploy(io).then((code) => {
      expect(code).toBe(1);
      expect(deployCalls).toEqual([]);
    });
  });

  test("an unchanged target still deploys", () => {
    const deployCalls: string[][] = [];
    const io = {
      collectSnapshot: () => CLEAN,
      runDryRun: () => ({ status: 0, output: prod("kindly-hound-172") }),
      runDeploy: (args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
    };
    return runGuardedDeploy(io).then((code) => {
      expect(code).toBe(0);
      expect(deployCalls).toHaveLength(1);
    });
  });

  test("a non-production target is refused — deploy:prod means production", () => {
    // looksLikeProduction previously only decorated a log line, so the command
    // would push to whatever the dry run resolved. A label is not a gate.
    const deployCalls: string[][] = [];
    const io = {
      collectSnapshot: () => CLEAN,
      runDryRun: () => ({
        status: 0,
        output: [
          "▌ [Preview] some-preview",
          "▌ └─ https://some-preview-123.convex.cloud",
        ].join("\n"),
      }),
      runDeploy: (args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "some-preview-123",
      isTTY: true,
      log: () => {},
      error: () => {},
    };
    return runGuardedDeploy(io).then((code) => {
      expect(code).toBe(1);
      expect(deployCalls).toEqual([]);
    });
  });
});
