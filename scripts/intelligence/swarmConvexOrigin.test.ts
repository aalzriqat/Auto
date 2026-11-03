// @vitest-environment node
/**
 * SCRUM-892: one Convex origin for the browser swarm. Several validators accept
 * it besides a cloud *.convex.cloud origin; some of them inline the literal
 * because Playwright loads them as CommonJS. This test is what keeps every
 * copy equal to the origin the local backend actually listens on.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTANCE_NAME, LOCAL_CONVEX_URL } from "../localConvexBackend.mjs";
import { previewNameForRef } from "../e2ePreviewBootstrap.mjs";
import {
  LOCAL_CONVEX_AUTHORITY,
  LOCAL_CONVEX_MODE,
  validateLocalConvexAuthority,
  writeLocalConvexAuthority,
} from "./localConvexAuthority.mjs";
import {
  SWARM_LOCAL_CONVEX_AUTHORITY,
  SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
  SWARM_LOCAL_CONVEX_ORIGIN,
  isSwarmLocalConvexUrl,
} from "./swarmConvexOrigin.mjs";

const read = (relative: string) => readFileSync(path.resolve(process.cwd(), relative), "utf8");

describe("swarm local Convex origin", () => {
  it("is exactly the origin, instance name and authority the local backend runner uses", () => {
    expect(SWARM_LOCAL_CONVEX_ORIGIN).toBe(LOCAL_CONVEX_URL);
    expect(SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME).toBe(INSTANCE_NAME);
    expect(SWARM_LOCAL_CONVEX_AUTHORITY).toBe(new URL(LOCAL_CONVEX_URL).host);
  });

  it("accepts the exact origin (with at most one trailing slash) and nothing else", () => {
    expect(isSwarmLocalConvexUrl("http://127.0.0.1:3210")).toBe(true);
    expect(isSwarmLocalConvexUrl("http://127.0.0.1:3210/")).toBe(true);
    for (const refused of [
      undefined,
      null,
      42,
      "",
      "http://127.0.0.1:3211",
      "http://localhost:3210",
      "https://127.0.0.1:3210",
      "http://127.0.0.2:3210",
      "http://127.0.0.1:3210//",
      "http://127.0.0.1:3210/x",
      "http://127.0.0.1:3210?x=1",
      "http://127.0.0.1:3210#x",
      "http://u@127.0.0.1:3210",
      " http://127.0.0.1:3210",
      "HTTP://127.0.0.1:3210",
      "http://127.0.0.1:3210.evil.example",
    ]) {
      expect(isSwarmLocalConvexUrl(refused), String(refused)).toBe(false);
    }
  });

  it("is dependency-free, because Playwright transpiles its readers to CommonJS", () => {
    const source = read("scripts/intelligence/swarmConvexOrigin.mjs")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toContain("import.meta");
    expect(source).not.toMatch(/\bawait\b/);
  });

  it("is the literal inlined by the CommonJS-loaded readers (browser swarm manifest, opening fixture, CSP)", () => {
    expect(read("scripts/intelligence/browserAttackSwarm.ts")).toContain(`"${SWARM_LOCAL_CONVEX_ORIGIN}"`);
    expect(read("playwright/fixtures/openingOnboarding.ts")).toContain(`"${SWARM_LOCAL_CONVEX_ORIGIN}"`);
  });
});

describe("local Convex authority artifact", () => {
  const PR = 892;
  const previewName = previewNameForRef({ ref: `refs/pull/${PR}/merge`, prNumber: String(PR) });
  const artifact = {
    version: 1,
    authority: LOCAL_CONVEX_AUTHORITY,
    mode: LOCAL_CONVEX_MODE,
    previewName,
    convexCloudUrl: SWARM_LOCAL_CONVEX_ORIGIN,
    deploymentName: SWARM_LOCAL_CONVEX_DEPLOYMENT_NAME,
  };

  it("validates the exact artifact and returns the same fields", () => {
    expect(validateLocalConvexAuthority(artifact, previewName)).toEqual(artifact);
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["an extra field", { ...artifact, adminKey: "x" }],
    ["a wrong authority", { ...artifact, authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW" }],
    ["a wrong mode", { ...artifact, mode: "CLOUD" }],
    ["a wrong preview name", { ...artifact, previewName: "e2e-pr-1-deadbeef00" }],
    ["a cloud URL", { ...artifact, convexCloudUrl: "https://x-y-1.convex.cloud" }],
    ["a trailing-slash URL", { ...artifact, convexCloudUrl: `${SWARM_LOCAL_CONVEX_ORIGIN}/` }],
    ["a wrong instance name", { ...artifact, deploymentName: "x-y-1" }],
  ])("refuses %s", (_label, value) => {
    expect(() => validateLocalConvexAuthority(value, previewName)).toThrow(/Local Convex authority/);
  });

  it("writes only the trusted constant artifact for the PR's own preview name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-authority-"));
    try {
      const written = await writeLocalConvexAuthority({ repoRoot: dir, env: { PR_NUMBER: String(PR) } });
      expect(written).toEqual(artifact);
      const onDisk = JSON.parse(await readFile(path.join(dir, "artifacts/browser-swarm-convex-authority.json"), "utf8"));
      expect(onDisk).toEqual(artifact);
      await expect(writeLocalConvexAuthority({ repoRoot: dir, env: { PR_NUMBER: "0" } })).rejects.toThrow(/PR_NUMBER/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
