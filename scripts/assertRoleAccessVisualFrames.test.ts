import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { EXPECTED_ROLE_FRAMES, roleArtifactErrors, roleFrameErrors, runRoleFrameCheck } from "./assertRoleAccessVisualFrames.mjs";

test("role frame inventory refuses absent, duplicate and empty evidence independently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "role-frame-census-"));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const files = EXPECTED_ROLE_FRAMES.map(name => { const file = path.join(dir, name); writeFileSync(file, bytes); return file; });
  expect(files).toHaveLength(48);
  expect(roleFrameErrors(files)).toEqual([]);
  expect(roleFrameErrors(files.slice(1))).toEqual([expect.stringContaining("expected one frame, found 0")]);
  mkdirSync(path.join(dir, "duplicate"));
  const duplicate = path.join(dir, "duplicate", EXPECTED_ROLE_FRAMES[0]); writeFileSync(duplicate, bytes);
  expect(roleFrameErrors([...files, duplicate])).toEqual([expect.stringContaining("found 2")]);
  writeFileSync(files[0], "");
  expect(roleFrameErrors(files)).toEqual([expect.stringContaining("empty or invalid PNG")]);
  expect(roleFrameErrors([])).toHaveLength(48);
});

test("the census CLI refuses an external root even when its frame inventory is complete", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "role-external-census-"));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  for (const name of EXPECTED_ROLE_FRAMES) writeFileSync(path.join(dir, name), bytes);
  const result = spawnSync(process.execPath, [path.resolve("scripts/assertRoleAccessVisualFrames.mjs"), dir],
    { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Only the repository visual artifact directory is allowed");
});

function artifactRepository() {
  const repository = mkdtempSync(path.join(tmpdir(), "role-owned-census-"));
  const root = path.join(repository, "test-results", "deal-cockpit-visual");
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  for (const name of EXPECTED_ROLE_FRAMES) writeFileSync(path.join(root, name), bytes);
  return { repository, root };
}

test("owned artifact traversal accepts complete evidence and refuses incomplete evidence", () => {
  const { repository, root } = artifactRepository();
  mkdirSync(path.join(root, "metadata"));
  writeFileSync(path.join(root, "metadata", "report.txt"), "Synthetic metadata");
  expect(roleArtifactErrors(repository)).toEqual([]);
  expect(runRoleFrameCheck(repository, [])).toBe(0);
  expect(roleArtifactErrors(repository, ["test-results/deal-cockpit-visual"])).toEqual([]);
  writeFileSync(path.join(root, EXPECTED_ROLE_FRAMES[0]), "");
  expect(roleArtifactErrors(repository)).toEqual([expect.stringContaining("empty or invalid PNG")]);
  expect(runRoleFrameCheck(repository, [])).toBe(1);
});

test("artifact location refusal is independent of whether an external directory has valid frames", () => {
  const { repository } = artifactRepository();
  const external = artifactRepository();
  expect(() => roleArtifactErrors(repository, [external.root])).toThrow("Only the repository visual artifact directory is allowed");
  expect(() => roleArtifactErrors(repository, ["test-results/deal-cockpit-visual", "extra"]))
    .toThrow("Only the repository visual artifact directory is allowed");
  const absent = mkdtempSync(path.join(tmpdir(), "role-absent-census-"));
  expect(() => roleArtifactErrors(absent)).toThrow(/ENOENT/);
  expect(runRoleFrameCheck(absent, [])).toBe(1);
});

test.each(["parent", "root"])("artifact traversal refuses a linked %s even with complete target frames", location => {
  const external = artifactRepository();
  const repository = mkdtempSync(path.join(tmpdir(), "role-linked-census-"));
  const parent = path.join(repository, "test-results");
  if (location === "root") mkdirSync(parent);
  const link = location === "parent" ? parent : path.join(parent, "deal-cockpit-visual");
  const target = location === "parent" ? path.dirname(external.root) : external.root;
  symlinkSync(target, link, "junction");
  expect(() => roleArtifactErrors(repository)).toThrow("Symlink is not an owned visual artifact");
});

test("artifact traversal refuses linked descendants and excessive nesting", () => {
  const linked = artifactRepository();
  const external = artifactRepository();
  symlinkSync(external.root, path.join(linked.root, "linked"), "junction");
  expect(() => roleArtifactErrors(linked.repository)).toThrow("Symlink is not an owned visual artifact");
  const deep = artifactRepository();
  mkdirSync(path.join(deep.root, "one", "two", "three", "four"), { recursive: true });
  expect(() => roleArtifactErrors(deep.repository)).toThrow("Role frame inventory exceeds supported artifact depth");
});
