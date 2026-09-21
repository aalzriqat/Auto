import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_MANIFEST_FILE,
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
