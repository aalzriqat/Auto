import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, buildShardFiles, shardNameFor } from "./baselineShards.mjs";
import { resolveGit } from "./gitExecutable.mjs";
import { serializeBaseline } from "./baselineFile.mjs";
import { readBaselineEntries } from "./baselineTestSupport.mjs";
import { entriesOfLegacyText, main, mergeEntryChanges } from "./shardBaseline.mjs";
import { main as verify } from "./verifyShardEquivalence.mjs";

/** @param {string} file @param {number} line @param {Record<string, unknown>} [over] */
const entry = (file, line, over = {}) => ({
  surface: "web", file, callSiteId: `${file}:${line}:1`, functionId: "deals:create", contractPath: "price", kind: "SHAPE_UNKNOWN",
  cause: "cause", fingerprint: "0123456789abcdef", multiplicity: 1, rationale: "reviewed", issue: "SCRUM-1", expires: "2999-01-01", ...over,
});
const a1 = entry("app/a.tsx", 1);
const a2 = entry("app/a.tsx", 2);
const b1 = entry("app/b.tsx", 1);

const legacyText = (/** @type {unknown[]} */ entries) => serializeBaseline({ version: 1, entries }, "");

/** @returns {{ log: string[], error: string[], io: { log: (l: string) => void, error: (l: string) => void } }} */
function capture() {
  /** @type {string[]} */ const log = [];
  /** @type {string[]} */ const error = [];
  return { log, error, io: { log: (l) => log.push(l), error: (l) => error.push(l) } };
}

/**
 * A throwaway repository shaped like the real situation: a merge base holding the single file, a pull request branch that
 * edited it, and a main that has since replaced it with shards.
 */
function repository() {
  const git = resolveGit();
  assert.ok(git, "git is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-shard-"));
  /** @param {string[]} args */
  const run = (args) => execFileSync(git, ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 20000 }).trim();
  const legacyPath = path.join(root, LEGACY_BASELINE_FILE);
  const write = (/** @type {unknown[]} */ entries) => {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, legacyText(entries));
  };
  run(["init", "--quiet", "--initial-branch=trunk"]);
  write([a1, a2, b1]);
  run(["add", "--", LEGACY_BASELINE_FILE]);
  run(["commit", "--quiet", "-m", "merge base"]);
  const mergeBase = run(["rev-parse", "HEAD"]);
  return { root, run, write, mergeBase, legacyPath, git };
}

/** Commit a branch that edits the single file, then return to trunk and shard it there (what main did in this change). */
function prAndShardedMain(/** @type {ReturnType<typeof repository>} */ r, /** @type {unknown[]} */ prEntries, /** @type {Array<Record<string, any>>} */ mainEntries = [a1, a2, b1]) {
  r.run(["checkout", "--quiet", "-b", "pr"]);
  r.write(prEntries);
  r.run(["add", "--", LEGACY_BASELINE_FILE]);
  r.run(["commit", "--quiet", "-m", "pr edits the single baseline"]);
  const prTip = r.run(["rev-parse", "HEAD"]);
  r.run(["checkout", "--quiet", "trunk"]);
  fs.rmSync(r.legacyPath);
  const directory = path.join(r.root, BASELINE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, text] of buildShardFiles(mainEntries)) fs.writeFileSync(path.join(directory, name), text);
  r.run(["add", "-A", "--", "scripts"]);
  r.run(["commit", "--quiet", "-m", "main shards the baseline"]);
  return { prTip, directory };
}

test("mergeEntryChanges: an addition, an edit and a removal made on a branch are applied to the current set", () => {
  const edited = { ...a2, rationale: "re-reviewed" };
  const c1 = entry("app/c.tsx", 1);
  const merged = mergeEntryChanges([a1, a2, b1], [a1, edited, c1], [a1, a2, b1]);
  assert.deepEqual({ added: merged.added, removed: merged.removed, changed: merged.changed, conflicts: merged.conflicts }, { added: 1, removed: 1, changed: 1, conflicts: [] });
  assert.deepEqual(new Set(merged.entries.map((e) => e.callSiteId)), new Set([a1, edited, c1].map((e) => e.callSiteId)));
  assert.equal(merged.entries.find((e) => e.callSiteId === a2.callSiteId)?.rationale, "re-reviewed");
});

test("mergeEntryChanges: applying the same branch twice changes nothing the second time", () => {
  const first = mergeEntryChanges([a1, b1], [a1, a2], [a1, b1]);
  const second = mergeEntryChanges([a1, b1], [a1, a2], first.entries);
  assert.equal(second.alreadyApplied, 2);
  assert.deepEqual({ added: second.added, removed: second.removed, changed: second.changed }, { added: 0, removed: 0, changed: 0 });
});

test("mergeEntryChanges: both sides editing one entry differently is a conflict and the entry is left alone", () => {
  const theirs = { ...a1, rationale: "branch wording" };
  const ours = { ...a1, rationale: "main wording" };
  const merged = mergeEntryChanges([a1], [theirs], [ours]);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.entries[0].rationale, "main wording");
});

test("mergeEntryChanges: a branch removal of an entry main has since edited is a conflict, not a silent delete", () => {
  const merged = mergeEntryChanges([a1, b1], [b1], [{ ...a1, rationale: "main edit" }, b1]);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.entries.length, 2);
});

test("mergeEntryChanges: a relocation (identity changed) is a removal plus an addition", () => {
  const moved = entry("app/a.tsx", 9);
  const merged = mergeEntryChanges([a1], [moved], [a1]);
  assert.deepEqual({ added: merged.added, removed: merged.removed, conflicts: merged.conflicts }, { added: 1, removed: 1, conflicts: [] });
});

test("mergeEntryChanges: a duplicate identity in any set is refused", () => {
  assert.throws(() => mergeEntryChanges([a1, a1], [a1], [a1]), /duplicate baseline identity in the merge base set/);
});

test("entriesOfLegacyText refuses a document that carries anything besides version and entries", () => {
  assert.throws(() => entriesOfLegacyText(serializeBaseline({ version: 1, entries: [], note: "x" }, "")), /refusing to drop fields/);
  assert.throws(() => entriesOfLegacyText(serializeBaseline({ version: 2, entries: [] }, "")), /refusing to drop fields/);
  assert.equal(entriesOfLegacyText(legacyText([a1])).length, 1);
});

test("--split reads the single file from git and writes shards that the equivalence proof accepts", () => {
  const r = repository();
  const { log, error, io } = capture();
  assert.equal(main(["--split", "--source-rev", r.mergeBase, "--write", "--remove-source", "--baseline", "shards"], io, r.root), 0, error.join("\n"));
  assert.match(log.join("\n"), /3 entries -> 2 shards, key-for-key and value-for-value equal/);
  assert.deepEqual(fs.readdirSync(path.join(r.root, "shards")).sort(), [shardNameFor("app/a.tsx"), shardNameFor("app/b.tsx")].sort());
  assert.equal(readBaselineEntries(path.join(r.root, "shards")).length, 3);
  const proof = capture();
  assert.equal(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], proof.io, r.root), 0, proof.error.join("\n"));
  assert.match(proof.log.join("\n"), /EQUIVALENT: 3 entries/);
});

test("--split refuses to run over a directory that already holds shards", () => {
  const r = repository();
  fs.mkdirSync(path.join(r.root, "shards"));
  fs.writeFileSync(path.join(r.root, "shards", "x.json"), "{}");
  const { error, io } = capture();
  assert.equal(main(["--split", "--source-rev", r.mergeBase, "--write", "--baseline", "shards"], io, r.root), 3);
  assert.match(error.join("\n"), /already sharded/);
});

test("--split with an unknown revision is UNAVAILABLE and writes nothing", () => {
  const r = repository();
  const { error, io } = capture();
  assert.equal(main(["--split", "--source-rev", "deadbeefdeadbeef", "--write", "--baseline", "shards"], io, r.root), 3);
  assert.match(error.join("\n"), /UNAVAILABLE; nothing was written/);
  assert.equal(fs.existsSync(path.join(r.root, "shards")), false);
});

test("--from-branch migrates a pull request's edits of the single file onto main's shards", () => {
  const r = repository();
  const edited = { ...a2, rationale: "re-reviewed" };
  const c1 = entry("app/c.tsx", 1);
  const { prTip, directory } = prAndShardedMain(r, [a1, edited, b1, c1]);
  const dry = capture();
  assert.equal(main(["--from-branch", prTip, "--base", "trunk"], dry.io, r.root), 0, dry.error.join("\n"));
  assert.match(dry.log.join("\n"), /1 added, 0 removed, 1 edited, 0 already applied, 0 conflicting/);
  assert.equal(readBaselineEntries(directory).length, 3, "a dry run writes nothing");
  const real = capture();
  assert.equal(main(["--from-branch", prTip, "--base", "trunk", "--write"], real.io, r.root), 0, real.error.join("\n"));
  assert.match(real.log.join("\n"), /wrote 2 shard\(s\), removed 0, left 1 untouched/);
  const names = fs.readdirSync(directory).sort();
  assert.deepEqual(names, [shardNameFor("app/a.tsx"), shardNameFor("app/b.tsx"), shardNameFor("app/c.tsx")].sort());
  const reloaded = readBaselineEntries(directory);
  assert.equal(reloaded.find((e) => e.callSiteId === a2.callSiteId)?.rationale, "re-reviewed");
  const again = capture();
  assert.equal(main(["--from-branch", prTip, "--base", "trunk", "--write"], again.io, r.root), 0, again.error.join("\n"));
  assert.match(again.log.join("\n"), /0 added, 0 removed, 0 edited, 2 already applied/);
  assert.match(again.log.join("\n"), /wrote 0 shard\(s\), removed 0/);
});

test("--from-branch removes a shard whose last entry the branch deleted", () => {
  const r = repository();
  const { prTip, directory } = prAndShardedMain(r, [a1, a2]);
  const { error, io } = capture();
  assert.equal(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root), 0, error.join("\n"));
  assert.deepEqual(fs.readdirSync(directory), [shardNameFor("app/a.tsx")]);
});

test("--from-branch reports a conflict, exits 10 and writes nothing when main and the branch changed the same entry", () => {
  const r = repository();
  const mainEdit = { ...a1, rationale: "main wording" };
  const { prTip, directory } = prAndShardedMain(r, [{ ...a1, rationale: "branch wording" }, a2, b1], [mainEdit, a2, b1]);
  const before = fs.readFileSync(path.join(directory, shardNameFor("app/a.tsx")), "utf8");
  const { error, io } = capture();
  assert.equal(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root), 10);
  assert.match(error.join("\n"), /CONFLICT/);
  assert.equal(fs.readFileSync(path.join(directory, shardNameFor("app/a.tsx")), "utf8"), before);
});

test("--from-branch refuses a branch tip that is already in the shard layout (name the tip from before main was merged)", () => {
  const r = repository();
  prAndShardedMain(r, [a1, a2]);
  const { error, io } = capture();
  assert.equal(main(["--from-branch", "trunk", "--base", "trunk"], io, r.root), 3);
  assert.match(error.join("\n"), /not both in the single-file layout/);
});

test("the equivalence proof exits 10 when a single value differs, and when a shard was hand-edited", () => {
  const r = repository();
  const split = capture();
  assert.equal(main(["--split", "--source-rev", r.mergeBase, "--write", "--baseline", "shards"], split.io, r.root), 0, split.error.join("\n"));
  const shard = path.join(r.root, "shards", shardNameFor("app/a.tsx"));
  const original = fs.readFileSync(shard, "utf8");
  fs.writeFileSync(shard, original.replace('"rationale": "reviewed"', '"rationale": "quietly reworded"'));
  const changed = capture();
  assert.equal(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], changed.io, r.root), 10);
  assert.match(changed.error.join("\n"), /NOT EQUIVALENT/);
  fs.writeFileSync(shard, original.replace("[\n", "[\n\n"));
  const reformatted = capture();
  assert.equal(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], reformatted.io, r.root), 10);
});

test("the equivalence proof is UNAVAILABLE, not a pass, without a revision or with a bad one", () => {
  const r = repository();
  assert.equal(verify([], capture().io, r.root), 3);
  assert.equal(verify(["--legacy-rev", "deadbeefdeadbeef"], capture().io, r.root), 3);
});
