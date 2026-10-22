import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { EXPECTED_ROLE_FRAMES, roleFrameErrors } from "./assertRoleAccessVisualFrames.mjs";

test("role frame inventory refuses absent, duplicate and empty evidence independently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "role-frame-census-"));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const files = EXPECTED_ROLE_FRAMES.map(name => { const file = path.join(dir, name); writeFileSync(file, bytes); return file; });
  expect(files).toHaveLength(44);
  expect(roleFrameErrors(files)).toEqual([]);
  expect(roleFrameErrors(files.slice(1))).toEqual([expect.stringContaining("expected one frame, found 0")]);
  mkdirSync(path.join(dir, "duplicate"));
  const duplicate = path.join(dir, "duplicate", EXPECTED_ROLE_FRAMES[0]); writeFileSync(duplicate, bytes);
  expect(roleFrameErrors([...files, duplicate])).toEqual([expect.stringContaining("found 2")]);
  writeFileSync(files[0], "");
  expect(roleFrameErrors(files)).toEqual([expect.stringContaining("empty or invalid PNG")]);
  expect(roleFrameErrors([])).toHaveLength(44);
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
