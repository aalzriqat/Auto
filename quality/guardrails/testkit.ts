// @vitest-environment node
/**
 * Shared fixtures for the SCRUM-426 ratchet and cross-domain tests. Same model
 * as guardrails.test.ts: every fixture is a real throwaway git repository whose
 * `main` commit is the trusted target and whose working tree is the PR.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect } from "vitest";

import { runGuardrails } from "./check.mjs";

export const TIMEOUT = 60_000;
export const ZERO_SHA = "0".repeat(40);
const repos: string[] = [];

/** Register a throwaway repository so `registerFixtureCleanup` removes it. */
export function trackRepo(root: string): string {
  repos.push(root);
  return root;
}

interface Entry {
  path: string;
  reason: string;
}
export interface FixtureConfig {
  schemaVersion: number;
  maxLines: number;
  productionRoots: string[];
  extensions: string[];
  exemptions: Entry[];
  generated: Entry[];
  migrations: Entry[];
}
export interface Grandfather {
  rule: string;
  from: string;
  to: string;
}
export interface FixtureBaseline {
  schemaVersion: number;
  sourceCommit: string;
  sizeCeilings: Record<string, number>;
  importGrandfather: Grandfather[];
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=guardrails@test", "-c", "user.name=guardrails", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

export function remove(root: string, file: string): void {
  rmSync(path.join(root, file));
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function baseConfig(): FixtureConfig {
  const reason = "fixture justification for this entry";
  return {
    schemaVersion: 1,
    maxLines: 600,
    productionRoots: ["components/", "convex/"],
    extensions: [".ts", ".tsx"],
    exemptions: [{ path: "convex/data.ts", reason }],
    generated: [{ path: "convex/_generated/server.ts", reason }],
    migrations: [{ path: "convex/migrateOld.ts", reason }],
  };
}

export function baseBaseline(): FixtureBaseline {
  return { schemaVersion: 1, sourceCommit: ZERO_SHA, sizeCeilings: {}, importGrandfather: [] };
}

export function writeConfig(root: string, config: FixtureConfig): void {
  write(root, "quality/guardrails/config.json", json(config));
}

export function writeBaselineDoc(root: string, baseline: FixtureBaseline): void {
  write(root, "quality/guardrails/baseline.json", json(baseline));
}

/**
 * A repo whose `main` commit is the trusted target, with guardrail files and the
 * given extra files already committed (so they are part of the TARGET tree).
 */
export function fixtureRepo(files: Record<string, string> = {}, { withGuardrails = true } = {}): string {
  const root = trackRepo(mkdtempSync(path.join(tmpdir(), "guardrails-rt-")));
  git(root, "init", "-q", "-b", "main");
  write(root, "convex/_generated/server.ts", "export const query = 1;\n");
  write(root, "convex/schema.ts", "export default {};\n");
  write(root, "convex/data.ts", "export const d = 1;\n");
  write(root, "convex/migrateOld.ts", "export const m = 1;\n");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  if (withGuardrails) {
    writeConfig(root, baseConfig());
    writeBaselineDoc(root, baseBaseline());
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "target");
  return root;
}

export function check(root: string) {
  return runGuardrails({ cwd: root, env: {}, base: "main" });
}

const FIXTURE_POLICY = {
  maxLines: 600,
  productionRoots: ["components/", "convex/"],
  extensions: [".ts", ".tsx"],
};

export function bootstrapCheck(root: string) {
  return runGuardrails({ cwd: root, env: {}, base: "main", bootstrapPolicy: FIXTURE_POLICY });
}

export function expectFailure(errors: string[], pattern: RegExp): void {
  expect(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join("\n")}`).toBe(true);
}

/** Register the per-file cleanup of fixture repositories. */
export function registerFixtureCleanup(): void {
  afterEach(() => {
    while (repos.length) rmSync(repos.pop() as string, { recursive: true, force: true });
  });
}
