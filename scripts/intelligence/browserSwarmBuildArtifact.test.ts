import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_MANIFEST_FILE,
  byCodeUnit,
  createBrowserSwarmBuildArtifact,
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

describe("byCodeUnit", () => {
  // The pnpm hoist copies packages in sorted order. Sonar S2871 requires an
  // explicit comparator, but it must keep the UTF-16 code-unit order that the
  // default Array#sort gave (upper case before lower case, "@" scopes first),
  // not a locale-aware order.
  it("orders exactly like the default sort for mixed-case and scoped names", () => {
    const names = ["zod", "Zod", "@swc", "@Types", "@types", "a-b", "A-B", "ab", "＠scope", "@scope"];
    expect([...names].sort(byCodeUnit)).toEqual([...names].sort());
  });

  it("is not locale-aware: upper case sorts before lower case", () => {
    expect(["a", "B"].sort(byCodeUnit)).toEqual(["B", "a"]);
  });

  it("returns 0 for equal names", () => {
    expect(byCodeUnit("x", "x")).toBe(0);
  });
});