import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEPENDENCY_SURFACE,
  StageRefusal,
  stageCandidateBackend,
} from "./stageCandidateBackend.mjs";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "stage-candidate-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const DEPENDENCIES = {
  "package.json": '{"name":"autoflow"}',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages: []\n",
  "convex.json": "{}",
};

function fixture(candidateExtra: Record<string, string> = {}) {
  const trusted = tree({ ...DEPENDENCIES, "tsconfig.json": '{"trusted":true}', "convex/old.ts": "old" });
  const candidate = tree({
    ...DEPENDENCIES,
    "tsconfig.json": '{"candidate":true}',
    "convex/deals.ts": "export const x = 1;",
    "convex/_generated/api.d.ts": "export {};",
    "lib/money.ts": "export const m = 2;",
    "components/Page.tsx": "frontend",
    ...candidateExtra,
  });
  const stageRoot = path.join(tree({}), "stage");
  return { trusted, candidate, stageRoot };
}

function stage(fx: ReturnType<typeof fixture>) {
  return stageCandidateBackend({
    candidateRoot: fx.candidate,
    trustedRoot: fx.trusted,
    stageRoot: fx.stageRoot,
    testedSha: "a".repeat(40),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("stageCandidateBackend (SCRUM-350 Option C)", () => {
  it("stages only convex/ and lib/ from the candidate, with trusted root files, and a manifest", () => {
    const fx = fixture();
    const manifest = stage(fx);

    expect(manifest.files.map((file) => file.path)).toEqual([
      "convex/_generated/api.d.ts",
      "convex/deals.ts",
      "lib/money.ts",
    ]);
    expect(manifest.testedSha).toBe("a".repeat(40));
    expect(manifest.files[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Frontend and candidate root config never reach the stage.
    expect(existsSync(path.join(fx.stageRoot, "components"))).toBe(false);
    // Root config is TRUSTED's, not the candidate's.
    expect(readFileSync(path.join(fx.stageRoot, "tsconfig.json"), "utf8")).toBe('{"trusted":true}');
    // Trusted's own backend source is not mixed in.
    expect(existsSync(path.join(fx.stageRoot, "convex/old.ts"))).toBe(false);
    expect(existsSync(path.join(fx.stageRoot, "node_modules"))).toBe(true);
  });

  it.each(DEPENDENCY_SURFACE)("refuses a candidate that changes %s", (name) => {
    const fx = fixture({ [name]: "changed by the candidate" });
    expect(() => stage(fx)).toThrow(StageRefusal);
    expect(() => stage(fx)).toThrow("Candidate changes " + name);
    expect(existsSync(path.join(fx.stageRoot, "convex"))).toBe(false);
  });

  it("refuses a candidate that removes a dependency file the trusted tree has", () => {
    const fx = fixture();
    rmSync(path.join(fx.candidate, "pnpm-workspace.yaml"));
    expect(() => stage(fx)).toThrow("Candidate removes pnpm-workspace.yaml");
  });

  it("refuses a symlink anywhere in the backend closure", () => {
    const fx = fixture();
    try {
      symlinkSync(path.join(fx.trusted, "tsconfig.json"), path.join(fx.candidate, "lib/leak.json"));
    } catch {
      // Unprivileged Windows cannot create symlinks; CI (Linux) always can.
      return;
    }
    expect(() => stage(fx)).toThrow("Candidate backend contains a symlink: lib/leak.json");
  });

  it("refuses a hard link, which would let a staged file alias one outside the tree", () => {
    const fx = fixture();
    linkSync(path.join(fx.candidate, "lib/money.ts"), path.join(fx.candidate, "lib/alias.ts"));
    expect(() => stage(fx)).toThrow("Candidate backend contains a hard link: lib/alias.ts");
  });

  it("refuses a .wasm file, which the Convex bundler loads as raw bytes", () => {
    const fx = fixture({ "convex/blob.WASM": "\0asm" });
    expect(() => stage(fx)).toThrow("Candidate backend contains a .wasm file: convex/blob.WASM");
  });

  it("refuses a nested package.json, which changes module resolution inside the tree", () => {
    const fx = fixture({ "lib/inner/package.json": '{"imports":{"#x":"/etc/passwd"}}' });
    expect(() => stage(fx)).toThrow("nested package.json: lib/inner/package.json");
  });

  it("refuses a node_modules directory inside the backend closure", () => {
    const fx = fixture({ "convex/node_modules/convex/bin/main.js": "evil" });
    expect(() => stage(fx)).toThrow("Candidate backend contains node_modules: convex/node_modules");
  });

  it("refuses a non-empty stage and relative roots", () => {
    const fx = fixture();
    mkdirSync(fx.stageRoot, { recursive: true });
    writeFileSync(path.join(fx.stageRoot, "stale.ts"), "stale");
    expect(() => stage(fx)).toThrow("STAGE_ROOT must be empty");
    expect(() =>
      stageCandidateBackend({ candidateRoot: "candidate", trustedRoot: fx.trusted, stageRoot: fx.stageRoot }),
    ).toThrow("CANDIDATE_ROOT must be an absolute path.");
  });

  it("refuses a candidate whose lib/ is not a plain directory", () => {
    const fx = fixture();
    rmSync(path.join(fx.candidate, "lib"), { recursive: true });
    writeFileSync(path.join(fx.candidate, "lib"), "not a directory");
    expect(() => stage(fx)).toThrow("Candidate lib/ is not a plain directory.");
  });
});
