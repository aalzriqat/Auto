import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import {
  ALLOWED_DEPLOY_ARGS,
  bundleOffenders,
  describeTargetSelection,
  evaluateProdDeploy,
  convexCliPath,
  parseCanonicalTarget,
  PRODUCTION_LABEL,
  freezeDeployEnv,
  FROZEN_DEPLOY_ENV_KEYS,
  resolveSelectors,
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
  approvedSha: "284e3e35e171313620c94f29a377c2ff6e1f4f78",
  headIsAncestorOfOriginMain: true,
  approvedIsAncestorOfOriginMain: true,
  trackedChanges: [],
  bundleFilesOnDisk: ["convex/schema.ts", "convex/socialInbox.ts"],
  trackedBundleFiles: ["convex/schema.ts", "convex/socialInbox.ts"],
  forwardedArgs: [],
  env: {},
};


/** The isolation members every standalone `io` fixture needs, kept in one place. */
const ISOLATION_STUB = {
  prepareIsolatedCheckout: (_sha: string) => ({ dir: "/tmp/iso-stub" }),
  installDependencies: (_dir: string) => ({ status: 0, output: "" }),
  cliExists: () => true,
  cleanupCheckout: (_dir: string) => {},
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

  test("--debug-bundle-path is refused — it reports success without deploying", () => {
    // Verified in the installed CLI: after bundling it logs "Wrote bundle and
    // metadata … Skipping rest of push." and exits 0. A wrapper that prints a
    // successful production deploy for a push that never happened is the
    // "merged is not deployed" failure with a green checkmark on it. It is also
    // hidden from --help and writes files, so it is refused on all three counts.
    expect(
      failureIds({ ...CLEAN, forwardedArgs: ["--debug-bundle-path", "/tmp/dbg"] })
    ).toContain("allowed-args-only");
  });

  test("a flag value is never mistaken for a flag", () => {
    // A disallowed flag and a bare `-y` in flag position must both be caught,
    // and neither may be excused by being adjacent to the other.
    expect(
      evaluateProdDeploy({ ...CLEAN, forwardedArgs: ["--message", "release", "-y"] }).ok
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
        approvedSha: "ba939af6".padEnd(40, "0"),
        headIsAncestorOfOriginMain: false,
        approvedIsAncestorOfOriginMain: false,
      })
    ).toContain("merged-into-main");
  });

  test("a diverged branch is not called 'behind', and is not offered --allow-behind", () => {
    const diverged: RepoSnapshot = {
      ...CLEAN,
      branch: "agent/deploy-target-guard",
      headSha: "0c57293e".padEnd(40, "0"),
      approvedSha: "0c57293e".padEnd(40, "0"),
      headIsAncestorOfOriginMain: false,
      approvedIsAncestorOfOriginMain: false,
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
      approvedSha: "52be7b4f".padEnd(40, "0"),
      approvedIsAncestorOfOriginMain: true,
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
      approvedSha: "ba939af6".padEnd(40, "0"),
      headIsAncestorOfOriginMain: false,
      approvedIsAncestorOfOriginMain: false,
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

  test("a git-quoted tracked path matches nothing, so the tracked list must be read with -z", () => {
    // Reproduced against this repo: `git ls-files convex/` applies
    // core.quotePath and emits "convex/prob\303\251.ts", while the disk walk
    // returns convex/probé.ts. The comparison is byte-exact, so the tracked file
    // is reported as an untracked offender and EVERY production deploy is
    // refused, naming a mangled path. `git ls-files -z` never quotes.
    //
    // This pins the mechanism, so that reading the tracked list without -z
    // cannot look harmless again: the suite already covered this quoting hazard
    // on the git status side and on the disk side, and missed this one.
    const quoted = String.raw`"convex/prob\303\251.ts"`;
    expect(bundleOffenders(["convex/probé.ts"], [quoted])).toEqual(["convex/probé.ts"]);
    expect(bundleOffenders(["convex/probé.ts"], ["convex/probé.ts"])).toEqual([]);
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

  test("the deployment name comes from the CLI's own canonical announcement", () => {
    // Read back rather than inferred from CONVEX_DEPLOYMENT, because inferring
    // the target from that variable is the mistake that caused the incident.
    const parsed = parseCanonicalTarget(REAL_DRY_RUN);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.name).toBe("kindly-hound-172");
    expect(parsed.label).toBe(PRODUCTION_LABEL);
  });

  test("a decoy target before the real announcement is never taken", () => {
    // ⚠️ REGRESSION, reproduced against the previous implementation.
    // `extractDeploymentName` and `looksLikeProduction` each scanned the whole
    // output independently, so the first `*.convex.cloud` anywhere won and any
    // `(prod)` anywhere satisfied the production gate. This exact input returned
    // `decoy-name` / `true`: the operator would be asked to confirm a name that
    // was not the deployment being pushed to, and the double dry run could not
    // catch it because both runs get identical args and so extract the same
    // wrong name twice. `--message` is forwardable and unvalidated, so operator
    // text does reach this stream.
    const decoyed = [
      "Deploy message: routine hotfix, see (prod) notes at https://decoy-name.convex.cloud/docs",
      "▌ Deploying code to deployment:",
      "▌ [Production] aalzriqat:auto:production (prod) (dashboard: .../kindly-hound-172)",
      "▌ └─ https://kindly-hound-172.convex.cloud",
    ].join("\n");
    const parsed = parseCanonicalTarget(decoyed);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.name).toBe("kindly-hound-172");
  });

  test("two announcements refuse rather than pick a winner", () => {
    // One deploy announces once. Two records mean the output is not the shape
    // this parser reads, and choosing between them is exactly how a guard
    // confirms one deployment while pushing to another.
    const twice = [
      "▌ [Production] a (prod)",
      "▌ └─ https://kindly-hound-172.convex.cloud",
      "▌ [Production] b (prod)",
      "▌ └─ https://some-other-deployment.convex.cloud",
    ].join("\n");
    const parsed = parseCanonicalTarget(twice);
    expect(parsed.kind).toBe("ambiguous");
    if (parsed.kind !== "ambiguous") return;
    expect(parsed.found.map((f) => f.name)).toEqual([
      "kindly-hound-172",
      "some-other-deployment",
    ]);
  });

  test("output with no announcement is missing, so the caller can refuse", () => {
    // A confirmation that cannot name the target is not a confirmation.
    expect(parseCanonicalTarget("some unrelated error").kind).toBe("missing");
  });

  test("a URL line without its tag line is not a record", () => {
    // Prose cannot form a record: it takes the bar-and-elbow frame on two
    // consecutive lines, which is what the CLI actually emits.
    expect(parseCanonicalTarget("▌ └─ https://kindly-hound-172.convex.cloud").kind).toBe(
      "missing"
    );
  });

  test("a non-production label is read as itself, not coerced", () => {
    const preview = ["▌ [Preview] x", "▌ └─ https://some-preview-123.convex.cloud"].join("\n");
    const parsed = parseCanonicalTarget(preview);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.label).toBe("Preview");
    expect(parsed.label).not.toBe(PRODUCTION_LABEL);
  });
});

describe("target selection is inventoried, not predicted", () => {
  /** Line breaks are a wrapping decision; the assertions below are about words. */
  const collapse = (text: string) => text.replace(/\s+/g, " ");

  /** Configurations that have each, at some point, produced a false sentence. */
  const PROSE_CONFIGURATIONS: RepoSnapshot["env"][] = [
    { CONVEX_DEPLOY_KEY: "prod:x|abc", CONVEX_SELF_HOSTED_URL: "https://internal" },
    { CONVEX_SELF_HOSTED_URL: "https://internal" },
    { CONVEX_SELF_HOSTED_URL: "https://internal", CONVEX_SELF_HOSTED_ADMIN_KEY: "k" },
    { CONVEX_DEPLOYMENT_TOKEN: "prod:x|abc" },
    { CONVEX_DEPLOY_KEY: "preview:x|abc" },
    { CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" },
    // The empty case used to return early with its own sentence, which is how
    // the last CLI prediction stayed out of the invariance check below.
    {},
  ];

  test("every set variable is listed, with where it came from", () => {
    const text = describeTargetSelection({
      CONVEX_DEPLOYMENT: "dev:vibrant-cat-418",
      CONVEX_DEPLOY_KEY: "prod:xxx",
      sources: { CONVEX_DEPLOYMENT: "process env", CONVEX_DEPLOY_KEY: ".env.local" },
    });
    expect(text).toContain("dev:vibrant-cat-418");
    expect(text).toContain("(from process env)");
    expect(text).toContain("CONVEX_DEPLOY_KEY set (from .env.local)");
  });

  test("secret values are never printed, only the fact that they are set", () => {
    // The CLI reads .env.local and .env itself, so a key can be in force without
    // appearing in process.env — the operator needs to know it exists and which
    // file to look in, and nothing more than that.
    for (const key of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_SELF_HOSTED_ADMIN_KEY"]) {
      const text = describeTargetSelection({ [key]: "prod:team|SUPERSECRET" });
      expect(text).toContain(`${key} set`);
      expect(text).not.toContain("SUPERSECRET");
    }
  });

  test("it says more than one may be set and that this wrapper does not guess", () => {
    // A multi-variable listing must not read as "all of these apply" — and
    // saying so needs no claim about which one the CLI picks. An earlier
    // wording, "the CLI acts on one of them", was itself wrong: the self-hosted
    // pair is selected by two variables together, and CONVEX_DEPLOYMENT next to
    // a self-hosted variable makes the CLI act on none of them and crash.
    const text = collapse(describeTargetSelection({ CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" }));
    expect(text).toMatch(/this wrapper does not guess which the CLI will act on/i);
  });

  test("the explanatory prose is identical in every configuration", () => {
    // This is the test the design rests on, so it asserts the property rather
    // than banning the two phrasings that happened to be wrong last time.
    //
    // Every defect in this function came from prose that varied with the
    // environment: CONVEX_DEPLOYMENT_TOKEN omitted, then the self-hosted branch
    // ordered ahead of the deploy key, then "targets PRODUCTION regardless"
    // (false for a preview deploy key). A denylist of past wordings cannot catch
    // the next one — a reworded prediction, or the round-3 falsehood restored in
    // different words, both passed the previous version of this test.
    //
    // If the only environment-dependent output is the indented inventory, no
    // such claim can exist, whatever words it would have used.
    const prose = (env: RepoSnapshot["env"]) =>
      describeTargetSelection(env)
        .split("\n")
        .filter((line) => !line.startsWith("  "));

    const baseline = prose({ CONVEX_DEPLOYMENT: "prod:kindly-hound-172" });
    for (const env of PROSE_CONFIGURATIONS) {
      expect(prose(env)).toEqual(baseline);
    }
  });

  test("the prose makes no claim about where 'convex deploy' would land", () => {
    // "targets the project's PRODUCTION deployment regardless of which of these
    // is set" is false for a preview deploy key — the CLI's own help says such a
    // key deploys to a preview deployment. What this wrapper does is its own
    // property and cannot go stale: it reads the target back and refuses one
    // that is not production.
    const text = collapse(describeTargetSelection({ CONVEX_DEPLOY_KEY: "preview:x|abc" }));
    expect(text).not.toMatch(/targets .*PRODUCTION/i);
    expect(text).toMatch(/read back from the CLI's own dry run/i);
    expect(text).toMatch(/does not announce itself as production is refused/i);
  });

  test("the inventory lines carry nothing but the variable, its value and its origin", () => {
    // The invariance test above filters out the indented lines, so they are
    // exempt from it by construction — it assumes they are an inventory without
    // ever checking. That assumption is the same door the last four defects came
    // through: appending "— this deploys to a self-hosted backend, not to Convex
    // Cloud" to a variable's row restores the round-3 falsehood and passes every
    // other test in this file. Verified.
    //
    // Asserting the row's shape closes it: non-indented lines are constant,
    // indented lines are structurally an inventory, so an environment-dependent
    // claim has nowhere left to live.
    const ROW = /^ {2}(\(none set\)|CONVEX_[A-Z_]+ (set|= \S+|= "")( \(from [^)]+\))?)$/;
    for (const env of PROSE_CONFIGURATIONS) {
      const rows = describeTargetSelection(env)
        .split("\n")
        .filter((line) => line.startsWith("  "));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatch(ROW);
    }
  });

  test("an unset environment is reported as unset, with no claim about the CLI", () => {
    // This said "the CLI will refuse rather than guess" -- the last surviving
    // prediction, and it survived precisely because the empty case returned
    // early and so sat outside the invariance check.
    const text = describeTargetSelection({});
    expect(text).toContain("(none set)");
    expect(collapse(text)).not.toMatch(/the CLI will refuse/i);
  });

  test("an empty value is shown as present and empty, not as absent", () => {
    // "" is an own property, so it stops the CLI's dotenv loading that variable
    // from a file -- a different state from unset, and one the operator has to
    // be able to see to explain why a file value is being ignored.
    const text = describeTargetSelection({ CONVEX_DEPLOYMENT: "" });
    expect(text).toContain('CONVEX_DEPLOYMENT = ""');
    expect(text).not.toContain("(none set)");
  });
});

describe("resolving the selection the CLI will make", () => {
  test("a BOM-prefixed .env.local is read, not silently treated as empty", () => {
    // PowerShell 5.1's `Out-File -Encoding UTF8` writes a BOM. parseEnv keeps it
    // inside the first key, so CONVEX_DEPLOYMENT read as unset — and an unset
    // selector is now pinned to "" and shadows the child's own dotenv, so the
    // CLI would refuse with "No CONVEX_DEPLOYMENT set" on a file it reads fine
    // itself. `pnpm deploy:prod` failing where `npx convex deploy` succeeds is
    // the worst possible incentive for a guard whose only power is being used.
    const resolved = resolveSelectors(
      {},
      [{ name: ".env.local", text: "﻿CONVEX_DEPLOYMENT=prod:kindly-hound-172\n" }]
    );
    expect(resolved.CONVEX_DEPLOYMENT).toBe("prod:kindly-hound-172");
    expect(resolved.sources?.CONVEX_DEPLOYMENT).toBe(".env.local");
  });

  test("each variable carries its own origin, so none has to be judged decisive", () => {
    // Reporting a single source meant choosing which variable the CLI would act
    // on — a model of its branch order, and the thing that kept being wrong.
    // Every origin is reported instead, which needs no such model.
    const resolved = resolveSelectors(
      { CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" },
      [{ name: ".env.local", text: "CONVEX_DEPLOY_KEY=prod:foo|abc\n" }]
    );
    expect(resolved.sources?.CONVEX_DEPLOYMENT).toBe("process env");
    expect(resolved.sources?.CONVEX_DEPLOY_KEY).toBe(".env.local");
  });

  test("process env wins over a file, as dotenv does not overwrite what is already set", () => {
    const resolved = resolveSelectors(
      { CONVEX_DEPLOYMENT: "prod:from-shell" },
      [{ name: ".env.local", text: "CONVEX_DEPLOYMENT=prod:from-file\n" }]
    );
    expect(resolved.CONVEX_DEPLOYMENT).toBe("prod:from-shell");
    expect(resolved.sources?.CONVEX_DEPLOYMENT).toBe("process env");
  });

  test(".env.local wins over .env", () => {
    const resolved = resolveSelectors({}, [
      { name: ".env.local", text: "CONVEX_DEPLOYMENT=prod:local\n" },
      { name: ".env", text: "CONVEX_DEPLOYMENT=prod:plain\n" },
    ]);
    expect(resolved.CONVEX_DEPLOYMENT).toBe("prod:local");
    expect(resolved.sources?.CONVEX_DEPLOYMENT).toBe(".env.local");
  });

  test("the grammar the hand-rolled reader got wrong", () => {
    // Each of these silently produced a wrong value before parseEnv: `export `
    // was skipped entirely, an inline # inside quotes truncated the value, and
    // an unterminated quote lost its last character.
    const resolved = resolveSelectors({}, [
      {
        name: ".env.local",
        text: [
          "export CONVEX_DEPLOYMENT=prod:kindly-hound-172 # team: autoflow",
          'CONVEX_DEPLOY_KEY="prod:foo|abc #def"',
        ].join("\n"),
      },
    ]);
    expect(resolved.CONVEX_DEPLOYMENT).toBe("prod:kindly-hound-172");
    expect(resolved.CONVEX_DEPLOY_KEY).toBe("prod:foo|abc #def");
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
    const envs: unknown[] = [];
    const cleanups: string[] = [];
    const installs: string[] = [];
    const clis: string[] = [];
    const cwds: string[] = [];
    const io = {
      collectSnapshot: () => CLEAN,
      prepareIsolatedCheckout: (_sha: string) => ({ dir: "/tmp/iso-abc123" }),
      installDependencies: (dir: string) => {
        installs.push(dir);
        return { status: 0, output: "" };
      },
      cliExists: () => true,
      cleanupCheckout: (dir: string) => {
        cleanups.push(dir);
      },
      runDryRun: (cliPath: string, cwd: string, args: string[], env: unknown) => {
        dryCalls.push(args);
        clis.push(cliPath);
        cwds.push(cwd);
        envs.push(env);
        return { status: 0, output: DRY_OUTPUT };
      },
      runDeploy: (cliPath: string, cwd: string, args: string[], env: unknown) => {
        deployCalls.push(args);
        clis.push(cliPath);
        cwds.push(cwd);
        envs.push(env);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
      ...overrides,
    };
    return { io, deployCalls, dryCalls, envs, cleanups, installs, clis, cwds };
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

  test("every child process gets the same frozen deployment selection", async () => {
    // What actually makes the confirmed target binding is that both dry runs
    // and the real deploy see one pinned selection instead of each resolving
    // from an environment that can change underneath them. That wiring was
    // asserted nowhere: the flow tests injected runDryRun handlers that ignored
    // the parameter entirely, so the freeze could have been dropped in silence.
    const env = {
      CONVEX_DEPLOYMENT: "prod:kindly-hound-172",
      sources: { CONVEX_DEPLOYMENT: "process env" },
    };
    const { io, envs } = harness({ collectSnapshot: () => ({ ...CLEAN, env }) });
    expect(await runGuardedDeploy(io)).toBe(0);

    // Two dry runs and one deploy.
    expect(envs).toHaveLength(3);
    for (const passed of envs) {
      expect(passed).toEqual(freezeDeployEnv(env));
      // Unset selectors must be "" and not absent: Node drops an undefined
      // value from a child's environment, and the child's own dotenv would then
      // read it off disk — reintroducing the substitution being prevented.
      for (const key of FROZEN_DEPLOY_ENV_KEYS) {
        expect(Object.hasOwn(passed as object, key)).toBe(true);
      }
    }
    expect((envs[0] as Record<string, string>).CONVEX_DEPLOYMENT).toBe(
      "prod:kindly-hound-172"
    );
  });

  test("the frozen selection covers every variable the CLI selects a target with", () => {
    // A variable the CLI reads but this does not freeze is not neutral — it is
    // ambient, and it can outrank the ones that are frozen. CONVEX_DEPLOYMENT_TOKEN
    // is the sharp case: the CLI reads the deploy key as
    // `CONVEX_DEPLOY_KEY || CONVEX_DEPLOYMENT_TOKEN`, and evaluates that branch
    // before CONVEX_DEPLOYMENT.
    expect([...FROZEN_DEPLOY_ENV_KEYS].sort((a, b) => a.localeCompare(b))).toEqual([
      "CONVEX_DEPLOY_KEY",
      "CONVEX_DEPLOYMENT",
      "CONVEX_DEPLOYMENT_TOKEN",
      "CONVEX_SELF_HOSTED_ADMIN_KEY",
      "CONVEX_SELF_HOSTED_URL",
    ]);
    expect(freezeDeployEnv({})).toEqual({
      CONVEX_DEPLOYMENT: "",
      CONVEX_DEPLOY_KEY: "",
      CONVEX_DEPLOYMENT_TOKEN: "",
      CONVEX_SELF_HOSTED_URL: "",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "",
    });
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

  test("the worktree changing mid-run cannot affect what is deployed", async () => {
    // ⚠️ This REPLACES a test that asserted the opposite mechanism, and the
    // swap is the whole point of the redesign — so it is stated rather than
    // quietly dropped.
    //
    // The old design re-read the worktree after the operator confirmed and
    // refused if it had changed. An independent review showed that window was
    // never actually closed: a second dry run ran AFTER the re-check, and a
    // file introduced during it still reached `runDeploy`.
    //
    // Now the deploy reads an isolated extract of one commit, so a worktree
    // change is not something to detect — it is something that cannot matter.
    // The assertion is therefore the stronger one: the snapshot goes on
    // changing underneath, and the deploy proceeds from the isolated directory
    // regardless, because nothing downstream ever consults the worktree again.
    let call = 0;
    const { io, deployCalls, cwds } = harness({
      collectSnapshot: () => {
        call += 1;
        return call === 1
          ? CLEAN
          : {
              ...CLEAN,
              bundleFilesOnDisk: [...CLEAN.bundleFilesOnDisk, "convex/probe211.ts"],
              trackedChanges: ["convex/schema.ts"],
            };
      },
    });
    expect(await runGuardedDeploy(io)).toBe(0);
    expect(deployCalls).toHaveLength(1);
    // Every child process ran in the isolated checkout, never the repo root.
    expect(new Set(cwds)).toEqual(new Set(["/tmp/iso-abc123"]));
    // And the guard only ever looked at the worktree once, up front.
    expect(call).toBe(1);
  });

  test("the isolated checkout is removed even when the deploy fails", async () => {
    const { io, cleanups } = harness({ runDeploy: () => 17 });
    expect(await runGuardedDeploy(io)).toBe(17);
    expect(cleanups).toEqual(["/tmp/iso-abc123"]);
  });

  test("the isolated checkout is removed even when a precondition refuses late", async () => {
    // A refusal after preparation must not leave a copy of the repository on
    // disk. `finally`, not a happy-path cleanup.
    const { io, cleanups, deployCalls } = harness({ prompt: async () => "wrong-name" });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(deployCalls).toEqual([]);
    expect(cleanups).toEqual(["/tmp/iso-abc123"]);
  });

  test("a failed isolated checkout refuses, and never reaches the CLI", async () => {
    const { io, deployCalls, dryCalls, cleanups } = harness({
      prepareIsolatedCheckout: () => ({ error: "git archive exploded" }),
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(dryCalls).toEqual([]);
    expect(deployCalls).toEqual([]);
    // Nothing was created, so there is nothing to clean up.
    expect(cleanups).toEqual([]);
  });

  test("a failed frozen install refuses before any deploy", async () => {
    const { io, deployCalls, dryCalls, cleanups } = harness({
      installDependencies: () => ({ status: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE" }),
    });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(dryCalls).toEqual([]);
    expect(deployCalls).toEqual([]);
    expect(cleanups).toEqual(["/tmp/iso-abc123"]);
  });

  test("the CLI that runs is the one inside the isolated checkout", async () => {
    // Not `npx`, not PATH, not the caller's node_modules: the binary that
    // pushes must come from the approved commit's own locked dependency set.
    const { io, clis } = harness();
    expect(await runGuardedDeploy(io)).toBe(0);
    expect(clis.length).toBeGreaterThan(0);
    for (const cli of clis) {
      expect(cli).toBe("/tmp/iso-abc123/node_modules/convex/bin/main.js");
    }
  });

  test("a missing CLI in the checkout refuses rather than falling back", async () => {
    const { io, dryCalls, deployCalls, cleanups } = harness({ cliExists: () => false });
    expect(await runGuardedDeploy(io)).toBe(1);
    expect(dryCalls).toEqual([]);
    expect(deployCalls).toEqual([]);
    expect(cleanups).toEqual(["/tmp/iso-abc123"]);
  });

  test("the checkout is prepared from the approved commit, not from HEAD", async () => {
    const requested: string[] = [];
    const { io } = harness({
      collectSnapshot: () => ({
        ...CLEAN,
        headSha: "ffffffff".padEnd(40, "0"),
        headIsAncestorOfOriginMain: false,
      }),
      prepareIsolatedCheckout: (sha: string) => {
        requested.push(sha);
        return { dir: "/tmp/iso-abc123" };
      },
    });
    expect(await runGuardedDeploy(io)).toBe(0);
    expect(requested).toEqual([CLEAN.approvedSha]);
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
    // Not a live bypass — commander binds `-y` as --message's argument rather
    // than as auto-confirm — but a rule that reads like one must not rest on
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
      runDryRun: (_cli: string, _cwd: string) => {
        resolution += 1;
        // First resolution: the name the operator is shown and confirms.
        // Second: something changed underneath.
        return { status: 0, output: prod(resolution === 1 ? "kindly-hound-172" : "vibrant-cat-418") };
      },
      runDeploy: (_cli: string, _cwd: string, args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
      ...ISOLATION_STUB,
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
      runDryRun: (_cli: string, _cwd: string) => ({ status: 0, output: prod("kindly-hound-172") }),
      runDeploy: (_cli: string, _cwd: string, args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "kindly-hound-172",
      isTTY: true,
      log: () => {},
      error: () => {},
      ...ISOLATION_STUB,
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
      runDeploy: (_cli: string, _cwd: string, args: string[]) => {
        deployCalls.push(args);
        return 0;
      },
      prompt: async () => "some-preview-123",
      isTTY: true,
      log: () => {},
      error: () => {},
      ...ISOLATION_STUB,
    };
    return runGuardedDeploy(io).then((code) => {
      expect(code).toBe(1);
      expect(deployCalls).toEqual([]);
    });
  });
});
