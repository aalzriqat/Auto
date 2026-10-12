import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_MANIFEST_FILE,
  byCodeUnit,
  createBrowserSwarmBuildArtifact,
  isAllowedDanglingHoistLink,
  verifyBrowserSwarmBuildArtifact,
} from "./browserSwarmBuildArtifact.mjs";

const identity = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  testedSha: "c".repeat(40),
  controllerSha: "d".repeat(40),
  prNumber: 325,
  runId: "gh-12345-1",
  previewName: "e2e-pr-325-abcdef1234",
  convexCloudUrl: "https://trusted-preview.convex.cloud",
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "autoflow-build-artifact-"));
  const candidateRoot = path.join(root, "candidate");
  const artifactRoot = path.join(root, "artifact");
  await mkdir(path.join(candidateRoot, ".next/standalone/.next"), {
    recursive: true,
  });
  await mkdir(path.join(candidateRoot, ".next/static/chunks"), {
    recursive: true,
  });
  await mkdir(path.join(candidateRoot, "public"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(candidateRoot, ".next/standalone/server.js"),
      "console.log('standalone');\n",
      "utf8",
    ),
    writeFile(
      path.join(candidateRoot, ".next/standalone/.next/required-server-files.json"),
      "{}\n",
      "utf8",
    ),
    writeFile(
      path.join(candidateRoot, ".next/static/chunks/app.js"),
      "console.log('chunk');\n",
      "utf8",
    ),
    writeFile(path.join(candidateRoot, "public/robots.txt"), "User-agent: *\n", "utf8"),
  ]);
  return { root, candidateRoot, artifactRoot };
}

describe("SCRUM-350 immutable candidate build artifact", () => {
  it("creates and independently verifies an exact identity-bound standalone artifact", async () => {
    const f = await fixture();
    try {
      const manifest = await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      expect(manifest.testedSha).toBe(identity.testedSha);
      expect(manifest.runId).toBe(identity.runId);
      expect(manifest.files.length).toBeGreaterThan(2);

      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).resolves.toMatchObject({
        testedSha: identity.testedSha,
        prNumber: identity.prNumber,
        runId: identity.runId,
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("hoists pnpm's virtual-store dependencies so the materialized tree can resolve them (SCRUM-376)", async () => {
    // Materializing pnpm's symlinked node_modules turns node_modules/next into a
    // real copy whose sibling dependencies (e.g. @swc/helpers) are no longer
    // reachable by Node's resolution, so `node server.js` died on require. A
    // real run failed exactly this way. The dependencies live under
    // node_modules/.pnpm/node_modules and must be reachable from node_modules.
    const f = await fixture();
    try {
      const nm = path.join(f.candidateRoot, ".next/standalone/node_modules");
      await mkdir(path.join(nm, "next"), { recursive: true });
      await mkdir(path.join(nm, ".pnpm/node_modules/@swc/helpers"), { recursive: true });
      await mkdir(path.join(nm, ".pnpm/node_modules/styled-jsx"), { recursive: true });
      await mkdir(path.join(nm, ".pnpm/node_modules/next"), { recursive: true });
      await writeFile(path.join(nm, "next/index.js"), "top-level next\n", "utf8");
      await writeFile(path.join(nm, ".pnpm/node_modules/next/index.js"), "virtual next\n", "utf8");
      await writeFile(path.join(nm, ".pnpm/node_modules/@swc/helpers/index.js"), "swc\n", "utf8");
      await writeFile(path.join(nm, ".pnpm/node_modules/styled-jsx/index.js"), "sjx\n", "utf8");

      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      const runtimeNm = path.join(f.artifactRoot, "runtime/node_modules");
      expect(await readFile(path.join(runtimeNm, "@swc/helpers/index.js"), "utf8")).toBe("swc\n");
      expect(await readFile(path.join(runtimeNm, "styled-jsx/index.js"), "utf8")).toBe("sjx\n");
      // An existing top-level package is never replaced by the virtual-store one.
      expect(await readFile(path.join(runtimeNm, "next/index.js"), "utf8")).toBe("top-level next\n");
      await expect(
        verifyBrowserSwarmBuildArtifact({ artifactRoot: f.artifactRoot, expected: identity }),
      ).resolves.toMatchObject({ testedSha: identity.testedSha });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses stale artifact reuse from another exact tested SHA", async () => {
    const f = await fixture();
    try {
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: { ...identity, testedSha: "e".repeat(40) },
        }),
      ).rejects.toThrow(/testedSha/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an artifact from another PR or workflow run", async () => {
    const f = await fixture();
    try {
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: { ...identity, prNumber: 999 },
        }),
      ).rejects.toThrow(/prNumber/);
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: { ...identity, runId: "gh-99999-2" },
        }),
      ).rejects.toThrow(/runId/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a candidate-style forged root manifest even when runtime bytes are untouched", async () => {
    const f = await fixture();
    try {
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      const manifestPath = path.join(f.artifactRoot, BUILD_MANIFEST_FILE);
      const forged = JSON.parse(await readFile(manifestPath, "utf8"));
      forged.testedSha = "f".repeat(40);
      await writeFile(manifestPath, JSON.stringify(forged), "utf8");

      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).rejects.toThrow(/testedSha/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses tampered, missing, or partial runtime content", async () => {
    const f = await fixture();
    try {
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      const serverPath = path.join(f.artifactRoot, "runtime/server.js");
      await writeFile(serverPath, "tampered\n", "utf8");
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).rejects.toThrow(/digest|hash|size/i);

      await rm(f.artifactRoot, { recursive: true, force: true });
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      await rm(path.join(f.artifactRoot, "runtime/.next/static/chunks/app.js"));
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).rejects.toThrow(/missing|file set|artifact/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the artifact or manifest is missing", async () => {
    const f = await fixture();
    try {
      await mkdir(f.artifactRoot, { recursive: true });
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).rejects.toThrow(/manifest/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects cache-poisoning shaped extra root content instead of treating it as reusable output", async () => {
    const f = await fixture();
    try {
      await createBrowserSwarmBuildArtifact({
        candidateRoot: f.candidateRoot,
        artifactRoot: f.artifactRoot,
        identity,
      });
      await writeFile(path.join(f.artifactRoot, "restored-cache.bin"), "poison", "utf8");
      await expect(
        verifyBrowserSwarmBuildArtifact({
          artifactRoot: f.artifactRoot,
          expected: identity,
        }),
      ).rejects.toThrow(/unexpected artifact root entry/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed on candidate-controlled pathological directory depth", async () => {
    const f = await fixture();
    try {
      let current = path.join(f.candidateRoot, ".next/standalone");
      for (let index = 0; index < 70; index += 1) {
        current = path.join(current, "d" + index);
        await mkdir(current);
      }

      await expect(
        createBrowserSwarmBuildArtifact({
          candidateRoot: f.candidateRoot,
          artifactRoot: f.artifactRoot,
          identity,
        }),
      ).rejects.toThrow(/maximum runtime directory depth/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("will not materialize a candidate symlink that escapes the candidate checkout", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside-secret.txt");
    try {
      await writeFile(outside, "must-not-copy", "utf8");
      await symlink(outside, path.join(f.candidateRoot, ".next/standalone/leak.txt"));
      await expect(
        createBrowserSwarmBuildArtifact({
          candidateRoot: f.candidateRoot,
          artifactRoot: f.artifactRoot,
          identity,
        }),
      ).rejects.toThrow(/escapes candidate root/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("SCRUM-824 dangling pnpm hoist-index links", () => {
  // PR #531's lockfile made Next's tracer emit
  // .pnpm/node_modules/supports-color without its target; realpath threw ENOENT
  // and the whole exact-candidate-build failed (runs 38217669760, 38188555038).
  // Owner ruling c22957: only a genuinely dangling leaf link inside the hoist
  // index, pointing back into the virtual store, may be omitted. Everything
  // else stays fail-closed.
  const build = (f: { candidateRoot: string; artifactRoot: string }) =>
    createBrowserSwarmBuildArtifact({
      candidateRoot: f.candidateRoot,
      artifactRoot: f.artifactRoot,
      identity,
    });

  async function hoistIndex(f: { candidateRoot: string }) {
    const index = path.join(f.candidateRoot, ".next/standalone/node_modules/.pnpm/node_modules");
    await mkdir(index, { recursive: true });
    return index;
  }

  async function manifestPaths(artifactRoot: string): Promise<string[]> {
    const manifest = JSON.parse(await readFile(path.join(artifactRoot, BUILD_MANIFEST_FILE), "utf8"));
    return manifest.files.map((file: { path: string }) => file.path);
  }

  it("omits the PR #531 supports-color dangling hoist link from the runtime and manifest", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await symlink("../supports-color@8.1.1/node_modules/supports-color", path.join(index, "supports-color"), "dir");
      await mkdir(path.join(index, "ms"), { recursive: true });
      await writeFile(path.join(index, "ms/index.js"), "ms\n", "utf8");

      await build(f);

      const runtimeNm = path.join(f.artifactRoot, "runtime/node_modules");
      expect(await readFile(path.join(runtimeNm, "ms/index.js"), "utf8")).toBe("ms\n");
      await expect(lstat(path.join(runtimeNm, "supports-color"))).rejects.toThrow(/ENOENT/);
      await expect(lstat(path.join(runtimeNm, ".pnpm/node_modules/supports-color"))).rejects.toThrow(/ENOENT/);
      expect((await manifestPaths(f.artifactRoot)).filter((p) => p.includes("supports-color"))).toEqual([]);
      await expect(
        verifyBrowserSwarmBuildArtifact({ artifactRoot: f.artifactRoot, expected: identity }),
      ).resolves.toMatchObject({ testedSha: identity.testedSha });
      // Absence is asserted on the artifact itself (above), never via Node's
      // module resolution, which also consults the ambient NODE_PATH (Opus N1).
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("omits a dangling scoped hoist link", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await mkdir(path.join(index, "@scope"), { recursive: true });
      await symlink("../../@scope+pkg@1.0.0/node_modules/@scope/pkg", path.join(index, "@scope/pkg"), "dir");
      await build(f);
      expect((await manifestPaths(f.artifactRoot)).filter((p) => p.includes("@scope"))).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("still materializes a resolvable hoist link as a real copy", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const target = path.join(index, "../has-flag@4.0.0/node_modules/has-flag");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "index.js"), "has-flag\n", "utf8");
      await symlink("../has-flag@4.0.0/node_modules/has-flag", path.join(index, "has-flag"), "dir");
      await build(f);
      const copied = path.join(f.artifactRoot, "runtime/node_modules/has-flag");
      expect((await lstat(copied)).isSymbolicLink()).toBe(false);
      expect(await readFile(path.join(copied, "index.js"), "utf8")).toBe("has-flag\n");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling link outside the hoist index with an explicit diagnostic", async () => {
    const f = await fixture();
    try {
      await hoistIndex(f);
      await mkdir(path.join(f.candidateRoot, ".next/standalone/node_modules"), { recursive: true });
      await symlink(
        ".pnpm/supports-color@8.1.1/node_modules/supports-color",
        path.join(f.candidateRoot, ".next/standalone/node_modules/supports-color"),
        "dir",
      );
      await expect(build(f)).rejects.toThrow(/dangling symlink.*not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling link nested below a hoisted package", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await mkdir(path.join(index, "pkg"), { recursive: true });
      // Target points into the store; the dedicated gate test is
      // "refuses a canonical-shaped dangling link that is not in the hoist index".
      await symlink("../../dep@1.0.0/node_modules/dep", path.join(index, "pkg/dep"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling hoist link whose target lands back inside the hoist index", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      // A different name, so the link dangles instead of looping onto itself.
      await symlink("../node_modules/absent-in-index", path.join(index, "into-index"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling hoist link whose target leaves the virtual store", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await symlink("../../../../missing-outside-store", path.join(index, "escape-rel"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  // Opus N2: each of these is refused by exactly one guard, so removing that
  // guard alone turns the case into an omission.
  it("refuses a canonical-shaped dangling link that is not in the hoist index (leaf/scope gate)", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const pkgDir = path.join(index, "../foo@1.0.0");
      await mkdir(pkgDir, { recursive: true });
      await symlink("../dep@1.0.0/node_modules/dep", path.join(pkgDir, "dep"), "dir");
      await expect(
        isAllowedDanglingHoistLink(path.join(pkgDir, "dep"), {
          root: await realpath(index),
          store: await realpath(path.dirname(index)),
        }),
      ).resolves.toBe(false);
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses canonical-shaped links with an invalid package name or no node_modules segment", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const hoist = { root: await realpath(index), store: await realpath(path.dirname(index)) };
      await symlink("../bin@1.0.0/node_modules/.bin", path.join(index, ".bin"), "dir");
      await symlink("../x@1.0.0/lib/x", path.join(index, "x"), "dir");
      await expect(isAllowedDanglingHoistLink(path.join(index, ".bin"), hoist)).resolves.toBe(false);
      await expect(isAllowedDanglingHoistLink(path.join(index, "x"), hoist)).resolves.toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("grants no omission when the hoist index is a symlink inside the store", async () => {
    const f = await fixture();
    try {
      const store = path.join(f.candidateRoot, ".next/standalone/node_modules/.pnpm");
      const realIndex = path.join(store, "real-index");
      await mkdir(realIndex, { recursive: true });
      await symlink(realIndex, path.join(store, "node_modules"), "dir");
      await symlink("../ghost@1.0.0/node_modules/ghost", path.join(realIndex, "ghost"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("omits a dangling link into a peer-suffixed store directory", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await symlink(
        "../debug@4.4.3_supports-color@8.1.1/node_modules/debug",
        path.join(index, "debug"),
        "dir",
      );
      await build(f);
      expect((await manifestPaths(f.artifactRoot)).filter((p) => p.includes("debug"))).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling hoist link redirected out of the store by a symlinked path component (Codex R1)", async () => {
    // path.resolve is lexical but the kernel follows .pnpm/redirect, so the
    // effective target is <candidate>/elsewhere/missing — outside the store.
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const elsewhere = path.join(f.candidateRoot, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, path.join(index, "../redirect"), "dir");
      await symlink("../redirect/missing", path.join(index, "escape"), "dir");
      await expect(
        isAllowedDanglingHoistLink(path.join(index, "escape"), {
          root: await realpath(index),
          store: await realpath(path.dirname(index)),
        }),
      ).resolves.toBe(false);
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling hoist link that climbs out through a symlink and back with '..' (Opus F1 S10)", async () => {
    // Lexically hop/.. cancels, so the target looks in-store; the kernel follows
    // hop to a directory outside the candidate root first.
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const outside = path.join(f.root, "hop-target");
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(f.candidateRoot, ".next/hop"), "dir");
      await symlink(
        "../../../../hop/../standalone/node_modules/.pnpm/absent@1.0.0/node_modules/hop-pkg",
        path.join(index, "hop-pkg"),
        "dir",
      );
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a canonical-shaped dangling link whose store directory is a symlink elsewhere (Opus F1 S12)", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const elsewhere = path.join(f.candidateRoot, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, path.join(index, "../x@1.0.0"), "dir");
      await symlink("../x@1.0.0/node_modules/x", path.join(index, "x"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses non-canonical hoist targets: '..' climbs and name mismatches (Opus F1 S2)", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      const hoist = { root: await realpath(index), store: await realpath(path.dirname(index)) };
      await symlink("../nonexistent-dir/../absent@1.0.0/node_modules/absent", path.join(index, "absent"), "dir");
      await symlink("../bar@1.0.0/node_modules/bar", path.join(index, "foo"), "dir");
      await expect(isAllowedDanglingHoistLink(path.join(index, "absent"), hoist)).resolves.toBe(false);
      await expect(isAllowedDanglingHoistLink(path.join(index, "foo"), hoist)).resolves.toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("grants no omission when the .pnpm virtual store itself is a symlink (Codex R1)", async () => {
    const f = await fixture();
    try {
      const realStore = path.join(f.candidateRoot, "forged-store");
      await mkdir(path.join(realStore, "node_modules"), { recursive: true });
      await mkdir(path.join(f.candidateRoot, ".next/standalone/node_modules"), { recursive: true });
      await symlink(realStore, path.join(f.candidateRoot, ".next/standalone/node_modules/.pnpm"), "dir");
      await symlink(
        "../supports-color@8.1.1/node_modules/supports-color",
        path.join(realStore, "node_modules/supports-color"),
        "dir",
      );
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling hoist link with an absolute target", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await symlink(path.join(index, "../absent@1.0.0/node_modules/absent"), path.join(index, "absent"), "dir");
      await expect(build(f)).rejects.toThrow(/not a pnpm hoist-index link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("still rejects an existing hoist link that escapes the candidate root", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside-pkg");
    try {
      const index = await hoistIndex(f);
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "index.js"), "must-not-copy", "utf8");
      await symlink(outside, path.join(index, "outside-pkg"), "dir");
      await expect(build(f)).rejects.toThrow(/escapes candidate root/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink cycle in the hoist index", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await symlink("loop-b", path.join(index, "loop-a"), "dir");
      await symlink("loop-a", path.join(index, "loop-b"), "dir");
      await expect(build(f)).rejects.toThrow(/ELOOP/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not treat an ordinary missing path as an omittable link", async () => {
    const f = await fixture();
    try {
      const index = await hoistIndex(f);
      await expect(
        isAllowedDanglingHoistLink(path.join(index, "never-existed"), {
          root: await realpath(index),
          store: await realpath(path.dirname(index)),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("byCodeUnit", () => {
  // The pnpm hoist copies packages in sorted order. Sonar S2871 requires an
  // explicit comparator, but it must keep the UTF-16 code-unit order that the
  // default Array#sort gave (upper case before lower case, "@" scopes first),
  // not a locale-aware order.
  it("orders exactly like the default sort for mixed-case and scoped names", () => {
    const names = ["zod", "Zod", "@swc", "@Types", "@types", "a-b", "A-B", "ab", "＠scope", "@scope"];
    expect([...names].sort(byCodeUnit)).toEqual([
      "@Types",
      "@scope",
      "@swc",
      "@types",
      "A-B",
      "Zod",
      "a-b",
      "ab",
      "zod",
      "＠scope",
    ]);
  });

  it("is not locale-aware: upper case sorts before lower case", () => {
    expect(["a", "B"].sort(byCodeUnit)).toEqual(["B", "a"]);
  });

  it("returns 0 for equal names", () => {
    expect(byCodeUnit("x", "x")).toBe(0);
  });
});
