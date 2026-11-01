// @vitest-environment node
/**
 * The SCRUM-873 author tools run IN PROCESS (shardBaseline: --split and --from-branch, verifyShardEquivalence) so the
 * Vitest lcov that Sonar reads counts them; the node:test files beside them (shardBaseline.test.mjs, shardCarry.test.mjs)
 * are not part of that report. Every fail-closed path has its own test: an input the tool cannot trust is a refusal with
 * a non-zero exit and nothing written, never a silent pass (SCRUM-760 ruling 3).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { serializeBaseline } from "./baselineFile.mjs";
import { baselineAtRevision } from "./baselineRevision.mjs";
import {
  BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, MAX_SHARD_NAME_LENGTH, buildShardFiles, canonicalJson, decodeShardName, encodeFilePath, loadShardedBaseline,
  parseShardSet, serializeShard, shardNameFor,
} from "./baselineShards.mjs";
import { readBaselineEntries, snapshotBaseline, writeBaselineDirectory } from "./baselineTestSupport.mjs";
import { resolveGit } from "./gitExecutable.mjs";
import { entriesOfLegacyText, main, mergeEntryChanges } from "./shardBaseline.mjs";
import { main as verify } from "./verifyShardEquivalence.mjs";

type Entry = Record<string, any>;

const entry = (file: string, line: number, over: Entry = {}): Entry => ({
  surface: "web", file, callSiteId: `${file}:${line}:1`, functionId: "deals:create", contractPath: "price", kind: "SHAPE_UNKNOWN",
  cause: "cause", fingerprint: "0123456789abcdef", multiplicity: 1, rationale: "reviewed", issue: "SCRUM-1", expires: "2999-01-01", ...over,
});
const a1 = entry("app/a.tsx", 1);
const a2 = entry("app/a.tsx", 2);
const b1 = entry("app/b.tsx", 1);
const legacyText = (entries: unknown[]) => serializeBaseline({ version: 1, entries }, "");

function capture() {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, io: { log: (line: string) => void log.push(line), error: (line: string) => void error.push(line) } };
}

// Each fixture builds a git repository; process start-up on a busy Windows runner can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const git = resolveGit();
if (!git) throw new Error("git is required for the shard tool tests");

/** A throwaway repository whose merge base holds the single baseline file. */
function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cs-shard-tools-")));
  created.push(root);
  const run = (...args: string[]) =>
    execFileSync(git as string, ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000,
    }).trim();
  const legacyPath = path.join(root, LEGACY_BASELINE_FILE);
  const write = (entries: unknown[]) => {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, legacyText(entries));
  };
  run("init", "--quiet", "--initial-branch=trunk");
  write([a1, a2, b1]);
  run("add", "--", LEGACY_BASELINE_FILE);
  run("commit", "--quiet", "-m", "merge base");
  return { root, run, write, legacyPath, mergeBase: run("rev-parse", "HEAD") };
}

/** A pull request that edited the single file, and a main that has since replaced it with shards. */
function prAndShardedMain(r: ReturnType<typeof repository>, prEntries: Entry[], mainEntries: Entry[] = [a1, a2, b1]) {
  r.run("checkout", "--quiet", "-b", "pr");
  r.write(prEntries);
  r.run("add", "--", LEGACY_BASELINE_FILE);
  r.run("commit", "--quiet", "--allow-empty", "-m", "pr edits the single baseline");
  const prTip = r.run("rev-parse", "HEAD");
  r.run("checkout", "--quiet", "trunk");
  fs.rmSync(r.legacyPath);
  const directory = path.join(r.root, BASELINE_DIRECTORY);
  writeBaselineDirectory(directory, mainEntries);
  r.run("add", "-A", "--", "scripts");
  r.run("commit", "--quiet", "-m", "main shards the baseline");
  return { prTip, directory };
}

describe("mergeEntryChanges", () => {
  test("an addition, an edit and a removal made on a branch are applied to the current set", () => {
    const edited: Entry = { ...a2, rationale: "re-reviewed" };
    const c1 = entry("app/c.tsx", 1);
    const merged = mergeEntryChanges([a1, a2, b1], [a1, edited, c1], [a1, a2, b1]);
    expect({ added: merged.added, removed: merged.removed, changed: merged.changed, conflicts: merged.conflicts }).toEqual({ added: 1, removed: 1, changed: 1, conflicts: [] });
    expect(merged.entries.find((e: Entry) => e.callSiteId === a2.callSiteId)?.rationale).toBe("re-reviewed");
    expect(merged.entries.map((e: Entry) => e.callSiteId).sort()).toEqual([a1, edited, c1].map((e) => e.callSiteId).sort());
  });

  test("applying the same branch twice changes nothing the second time", () => {
    const first = mergeEntryChanges([a1, b1], [a1, a2], [a1, b1]);
    const second = mergeEntryChanges([a1, b1], [a1, a2], first.entries);
    expect(second.alreadyApplied).toBe(2);
    expect({ added: second.added, removed: second.removed, changed: second.changed }).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  test("both sides editing one entry differently is a conflict and the entry is left alone", () => {
    const merged = mergeEntryChanges([a1], [{ ...a1, rationale: "branch" }], [{ ...a1, rationale: "main" }]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.entries[0].rationale).toBe("main");
  });

  test("a branch removal of an entry main has since edited is a conflict, not a silent delete", () => {
    const merged = mergeEntryChanges([a1, b1], [b1], [{ ...a1, rationale: "main edit" }, b1]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.entries).toHaveLength(2);
  });

  test("a branch addition main also made differently is a conflict", () => {
    const merged = mergeEntryChanges([], [a1], [{ ...a1, rationale: "main" }]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.added).toBe(0);
  });

  test("a relocation (identity changed) is a removal plus an addition", () => {
    const merged = mergeEntryChanges([a1], [entry("app/a.tsx", 9)], [a1]);
    expect({ added: merged.added, removed: merged.removed, conflicts: merged.conflicts }).toEqual({ added: 1, removed: 1, conflicts: [] });
  });

  test("an entry the branch did not touch is left exactly as main has it", () => {
    const mainEdit = { ...b1, rationale: "main only" };
    const merged = mergeEntryChanges([a1, b1], [a1, b1, a2], [a1, mainEdit]);
    expect(merged.entries.find((e: Entry) => e.callSiteId === b1.callSiteId)?.rationale).toBe("main only");
    expect(merged.added).toBe(1);
  });

  test.each([
    ["merge base", [a1, a1], [a1], [a1]],
    ["branch", [a1], [a1, a1], [a1]],
    ["current", [a1], [a1], [a1, a1]],
  ] as const)("a duplicate identity in the %s set is refused", (role, base, theirs, ours) => {
    expect(() => mergeEntryChanges([...base], [...theirs], [...ours])).toThrow(new RegExp(`duplicate baseline identity in the ${role} set`));
  });
});

describe("entriesOfLegacyText", () => {
  test("accepts exactly {version: 1, entries}", () => {
    expect(entriesOfLegacyText(legacyText([a1]))).toHaveLength(1);
  });

  test.each([
    ["an extra field", { version: 1, entries: [], note: "x" }],
    ["another version", { version: 2, entries: [] }],
    ["no entries array", { version: 1, entries: "nope" }],
  ])("refuses %s rather than dropping it", (_label, document) => {
    expect(() => entriesOfLegacyText(serializeBaseline(document, ""))).toThrow(/refusing to drop fields/);
  });

  test("refuses text that is not canonical 2-space JSON, and text that is not JSON", () => {
    expect(() => entriesOfLegacyText(JSON.stringify({ version: 1, entries: [] }))).toThrow(/canonical/);
    expect(() => entriesOfLegacyText("{ not json")).toThrow();
  });
});

describe("shardBaseline main: argument validation", () => {
  test.each([
    ["neither mode", []],
    ["both modes", ["--split", "--from-branch", "pr"]],
    ["--remove-source without --write", ["--split", "--remove-source"]],
    ["--remove-source with --from-branch", ["--from-branch", "pr", "--write", "--remove-source"]],
    ["an unknown option", ["--split", "--nonsense"]],
  ])("%s is UNAVAILABLE and writes nothing", (_label, argv) => {
    const r = repository();
    const { error, io } = capture();
    expect(main(argv, io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/UNAVAILABLE; nothing was written/);
  });

  test("a baseline path outside the repository root is refused", () => {
    const r = repository();
    const { error, io } = capture();
    expect(main(["--split", "--source-rev", r.mergeBase, "--baseline", "../outside"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/outside the repository root/);
  });
});

describe("shardBaseline --split", () => {
  test("a dry run reports the shards and writes nothing", () => {
    const r = repository();
    const { log, io } = capture();
    expect(main(["--split", "--source-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(0);
    expect(log.join("\n")).toMatch(/3 entries -> 2 shards, key-for-key and value-for-value equal\. Dry run/);
    expect(fs.existsSync(path.join(r.root, "shards"))).toBe(false);
  });

  test("reads the single file from git, writes shards the equivalence proof accepts, and can remove the source", () => {
    const r = repository();
    const { log, error, io } = capture();
    expect(main(["--split", "--source-rev", r.mergeBase, "--write", "--remove-source", "--baseline", "shards"], io, r.root)).toBe(0);
    expect(error).toEqual([]);
    expect(log.join("\n")).toMatch(/Writing\./);
    expect(log.join("\n")).toMatch(/removed scripts\/contractSkew\/needs-evidence-baseline\.json/);
    expect(fs.existsSync(r.legacyPath)).toBe(false);
    expect(fs.readdirSync(path.join(r.root, "shards")).sort()).toEqual([shardNameFor("app/a.tsx"), shardNameFor("app/b.tsx")].sort());
    expect(readBaselineEntries(path.join(r.root, "shards"))).toHaveLength(3);
    const proof = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], proof.io, r.root)).toBe(0);
  });

  test("reads the single file from the working tree with --source", () => {
    const r = repository();
    const { log, io } = capture();
    expect(main(["--split", "--write", "--baseline", "shards"], io, r.root)).toBe(0);
    expect(log.join("\n")).toMatch(/3 entries -> 2 shards/);
    expect(fs.existsSync(r.legacyPath)).toBe(true);
    expect(readBaselineEntries(path.join(r.root, "shards"))).toHaveLength(3);
  });

  test("refuses to run over a directory that already holds shards, and leaves it untouched", () => {
    const r = repository();
    const directory = writeBaselineDirectory(path.join(r.root, "shards"), [a1]);
    const before = snapshotBaseline(directory);
    const { error, io } = capture();
    expect(main(["--split", "--source-rev", r.mergeBase, "--write", "--baseline", "shards"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/already sharded/);
    expect(snapshotBaseline(directory)).toBe(before);
  });

  test("an unknown revision is UNAVAILABLE and writes nothing", () => {
    const r = repository();
    const { error, io } = capture();
    expect(main(["--split", "--source-rev", "deadbeefdeadbeef", "--write", "--baseline", "shards"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/UNAVAILABLE; nothing was written/);
    expect(fs.existsSync(path.join(r.root, "shards"))).toBe(false);
  });

  test("an option-shaped revision is refused before git sees it", () => {
    const r = repository();
    const { io } = capture();
    expect(main(["--split", "--source-rev", "--output=x", "--baseline", "shards"], io, r.root)).toBe(3);
  });

  test("a missing source file is UNAVAILABLE", () => {
    const r = repository();
    fs.rmSync(r.legacyPath);
    const { error, io } = capture();
    expect(main(["--split", "--write", "--baseline", "shards"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/UNAVAILABLE/);
    expect(fs.existsSync(path.join(r.root, "shards"))).toBe(false);
  });

  test.each([
    ["an empty baseline", legacyText([])],
    ["a duplicate identity", legacyText([a1, a1])],
    ["an entry with no client file", legacyText([{ ...a1, file: "" }])],
    ["a document that is not canonical JSON", JSON.stringify({ version: 1, entries: [a1] })],
    ["a document with an extra field", serializeBaseline({ version: 1, entries: [a1], note: 1 }, "")],
    ["text that is not JSON", "{ nope"],
  ])("%s in the source is refused and nothing is written", (_label, text) => {
    const r = repository();
    fs.writeFileSync(r.legacyPath, text);
    const { error, io } = capture();
    expect(main(["--split", "--write", "--baseline", "shards"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/UNAVAILABLE; nothing was written/);
    expect(fs.existsSync(path.join(r.root, "shards"))).toBe(false);
  });
});

describe("shardBaseline --from-branch", () => {
  test("migrates a pull request's edits of the single file onto main's shards, and is idempotent", () => {
    const r = repository();
    const edited = { ...a2, rationale: "re-reviewed" };
    const c1 = entry("app/c.tsx", 1);
    const { prTip, directory } = prAndShardedMain(r, [a1, edited, b1, c1]);
    const dry = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk"], dry.io, r.root)).toBe(0);
    expect(dry.log.join("\n")).toMatch(/1 added, 0 removed, 1 edited, 0 already applied, 0 conflicting/);
    expect(dry.log.join("\n")).toMatch(/Dry run/);
    expect(readBaselineEntries(directory)).toHaveLength(3);

    const real = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], real.io, r.root)).toBe(0);
    expect(real.log.join("\n")).toMatch(/wrote 2 shard\(s\), removed 0, left 1 untouched/);
    expect(fs.readdirSync(directory).sort()).toEqual([shardNameFor("app/a.tsx"), shardNameFor("app/b.tsx"), shardNameFor("app/c.tsx")].sort());
    expect(readBaselineEntries(directory).find((e: Entry) => e.callSiteId === a2.callSiteId)?.rationale).toBe("re-reviewed");

    const again = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], again.io, r.root)).toBe(0);
    expect(again.log.join("\n")).toMatch(/0 added, 0 removed, 0 edited, 2 already applied/);
    expect(again.log.join("\n")).toMatch(/wrote 0 shard\(s\), removed 0/);
  });

  test("removes a shard whose last entry the branch deleted", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2]);
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(0);
    expect(error).toEqual([]);
    expect(fs.readdirSync(directory)).toEqual([shardNameFor("app/a.tsx")]);
  });

  test("a conflict exits 10 and writes nothing", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [{ ...a1, rationale: "branch" }, a2, b1], [{ ...a1, rationale: "main" }, a2, b1]);
    const before = snapshotBaseline(directory);
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/CONFLICT/);
    expect(snapshotBaseline(directory)).toBe(before);
  });

  test("a branch that edits no baseline entry has nothing to migrate", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2, b1]);
    const before = snapshotBaseline(directory);
    const { log, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(0);
    expect(log.join("\n")).toMatch(/nothing to migrate/);
    expect(snapshotBaseline(directory)).toBe(before);
  });

  test("refuses a branch tip that is already in the shard layout", () => {
    const r = repository();
    prAndShardedMain(r, [a1, a2]);
    const { error, io } = capture();
    expect(main(["--from-branch", "trunk", "--base", "trunk"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/not both in the single-file layout/);
  });

  test("an unknown branch is UNAVAILABLE", () => {
    const r = repository();
    prAndShardedMain(r, [a1, a2]);
    const { io } = capture();
    expect(main(["--from-branch", "no-such-branch", "--base", "trunk"], io, r.root)).toBe(3);
  });

  test("a missing shard directory refuses instead of migrating onto nothing", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2, b1, entry("app/c.tsx", 1)]);
    fs.rmSync(directory, { recursive: true });
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/is absent; an absent baseline is not an empty one/);
    expect(fs.existsSync(directory)).toBe(false);
  });

  test("an empty shard directory refuses", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2, b1, entry("app/c.tsx", 1)]);
    fs.rmSync(directory, { recursive: true });
    fs.mkdirSync(directory);
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/holds no shards/);
  });

  test("a malformed shard refuses and the directory is untouched", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2, b1, entry("app/c.tsx", 1)]);
    fs.writeFileSync(path.join(directory, shardNameFor("app/b.tsx")), "{ not json");
    const before = snapshotBaseline(directory);
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/not valid JSON/);
    expect(snapshotBaseline(directory)).toBe(before);
  });

  test("an entry in the wrong shard, repeated from another shard, refuses", () => {
    const r = repository();
    const { prTip, directory } = prAndShardedMain(r, [a1, a2, b1, entry("app/c.tsx", 1)]);
    fs.writeFileSync(path.join(directory, shardNameFor("app/b.tsx")), serializeShard("app/b.tsx", [b1, a1]));
    const { error, io } = capture();
    expect(main(["--from-branch", prTip, "--base", "trunk", "--write"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/wrong shard/);
    expect(error.join("\n")).toMatch(/duplicate baseline entry/);
  });
});

describe("verifyShardEquivalence", () => {
  function splitRepository() {
    const r = repository();
    const split = capture();
    expect(main(["--split", "--source-rev", r.mergeBase, "--write", "--baseline", "shards"], split.io, r.root)).toBe(0);
    return { ...r, shard: path.join(r.root, "shards", shardNameFor("app/a.tsx")) };
  }

  test("an exact split is EQUIVALENT and reports every surface it holds", () => {
    const r = repository();
    r.write([a1, a2, entry("app/m.tsx", 1, { surface: "mobile" }), b1]);
    r.run("add", "--", LEGACY_BASELINE_FILE);
    r.run("commit", "--quiet", "-m", "two surfaces");
    const rev = r.run("rev-parse", "HEAD");
    expect(main(["--split", "--source-rev", rev, "--write", "--baseline", "shards"], capture().io, r.root)).toBe(0);
    const proof = capture();
    expect(verify(["--legacy-rev", rev, "--baseline", "shards"], proof.io, r.root)).toBe(0);
    const text = proof.log.join("\n");
    expect(text).toMatch(/legacy .* 4 entries \{"mobile":1,"web":3\}/);
    expect(text).toMatch(/shards shards:4 entries in 3 shards \{"mobile":1,"web":3\}/);
    expect(text).toMatch(/entry sets: EQUAL/);
    expect(text).toMatch(/byte-stable regeneration: every shard reproduced exactly/);
    expect(text).toMatch(/EQUIVALENT: 4 entries/);
  });

  test("a single changed value is NOT EQUIVALENT (exit 10)", () => {
    const r = splitRepository();
    fs.writeFileSync(r.shard, fs.readFileSync(r.shard, "utf8").replace('"rationale": "reviewed"', '"rationale": "quietly reworded"'));
    const { log, error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/NOT EQUIVALENT/);
    expect(log.join("\n")).toMatch(/entry sets: DIFFERENT/);
  });

  test("a reformatted shard is refused by the loader (exit 10)", () => {
    const r = splitRepository();
    fs.writeFileSync(r.shard, fs.readFileSync(r.shard, "utf8").replace("[\n", "[\n\n"));
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/does not load/);
  });

  test("a missing entry is NOT EQUIVALENT", () => {
    const r = splitRepository();
    fs.writeFileSync(r.shard, serializeShard("app/a.tsx", [a1]));
    const { log, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(log.join("\n")).toMatch(/only in legacy 1/);
  });

  test("an extra shard that the old file never held is NOT EQUIVALENT", () => {
    const r = splitRepository();
    fs.writeFileSync(path.join(r.root, "shards", shardNameFor("app/z.tsx")), serializeShard("app/z.tsx", [entry("app/z.tsx", 1)]));
    const { log, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(log.join("\n")).toMatch(/only in shards 1/);
    expect(log.join("\n")).toMatch(/1 shard\(s\) differ: /);
  });

  test("a missing shard directory is NOT EQUIVALENT, not a pass", () => {
    const r = repository();
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/does not load: .*absent/);
  });

  test("an empty shard directory is NOT EQUIVALENT", () => {
    const r = repository();
    fs.mkdirSync(path.join(r.root, "shards"));
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/holds no shards/);
  });

  test("a duplicate entry across shards is NOT EQUIVALENT", () => {
    const r = splitRepository();
    fs.writeFileSync(path.join(r.root, "shards", shardNameFor("app/b.tsx")), serializeShard("app/b.tsx", [b1, a1]));
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/duplicate baseline entry/);
  });

  test("a stray file in the shard directory is NOT EQUIVALENT", () => {
    const r = splitRepository();
    fs.writeFileSync(path.join(r.root, "shards", "README.md"), "x");
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "shards"], io, r.root)).toBe(10);
    expect(error.join("\n")).toMatch(/stray or unknown file/);
  });

  test("no revision, a bad revision, an option-shaped revision, a revision without the single file: UNAVAILABLE (exit 3)", () => {
    const r = repository();
    expect(verify([], capture().io, r.root)).toBe(3);
    expect(verify(["--legacy-rev", "deadbeefdeadbeef"], capture().io, r.root)).toBe(3);
    expect(verify(["--legacy-rev", "--output=x"], capture().io, r.root)).toBe(3);
    const empty = r.run("commit-tree", "-m", "no baseline", "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    const { error, io } = capture();
    expect(verify(["--legacy-rev", empty], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/UNAVAILABLE; nothing was proven/);
  });

  test("a baseline path outside the root is UNAVAILABLE", () => {
    const r = repository();
    expect(verify(["--legacy-rev", r.mergeBase, "--baseline", "../outside"], capture().io, r.root)).toBe(3);
  });

  test("a legacy document that carries anything but version and entries is UNAVAILABLE", () => {
    const r = repository();
    fs.writeFileSync(r.legacyPath, serializeBaseline({ version: 1, entries: [a1], note: "x" }, ""));
    r.run("add", "--", LEGACY_BASELINE_FILE);
    r.run("commit", "--quiet", "-m", "extra field");
    const { error, io } = capture();
    expect(verify(["--legacy-rev", r.run("rev-parse", "HEAD"), "--baseline", "shards"], io, r.root)).toBe(3);
    expect(error.join("\n")).toMatch(/refusing to drop fields/);
  });
});

describe("baselineAtRevision", () => {
  test("reads the single-file layout and the shard layout, and agrees on the entries", () => {
    const r = repository();
    const { prTip } = prAndShardedMain(r, [a1, a2]);
    const legacy = baselineAtRevision(git as string, r.root, r.mergeBase);
    const shards = baselineAtRevision(git as string, r.root, "trunk");
    expect([legacy.layout, shards.layout]).toEqual(["legacy", "shards"]);
    expect(legacy.entries).toHaveLength(3);
    expect(shards.entries).toHaveLength(3);
    expect(JSON.parse(shards.text).entries).toHaveLength(3);
    expect(baselineAtRevision(git as string, r.root, prTip).entries).toHaveLength(2);
  });

  test("a shard set at a revision that does not load is refused, naming the revision", () => {
    const r = repository();
    fs.rmSync(r.legacyPath);
    const directory = path.join(r.root, BASELINE_DIRECTORY);
    writeBaselineDirectory(directory, [a1]);
    fs.writeFileSync(path.join(directory, "stray.json"), "{}");
    r.run("add", "-A", "--", "scripts");
    r.run("commit", "--quiet", "-m", "stray shard");
    expect(() => baselineAtRevision(git as string, r.root, "HEAD")).toThrow(/baseline shards at HEAD are not trustworthy/);
  });

  test("a revision with neither layout is refused", () => {
    const r = repository();
    const empty = r.run("commit-tree", "-m", "no baseline", "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(() => baselineAtRevision(git as string, r.root, empty)).toThrow(/no needs-evidence baseline/);
  });

  test("a single-file baseline without an entries array is refused", () => {
    const r = repository();
    fs.writeFileSync(r.legacyPath, JSON.stringify({ version: 1 }));
    r.run("add", "--", LEGACY_BASELINE_FILE);
    r.run("commit", "--quiet", "-m", "no entries");
    expect(() => baselineAtRevision(git as string, r.root, "HEAD")).toThrow(/has no entries array/);
  });

  test("a shard committed as a symlink is not read as a regular file", () => {
    const r = repository();
    fs.rmSync(r.legacyPath);
    const directory = path.join(r.root, BASELINE_DIRECTORY);
    writeBaselineDirectory(directory, [a1]);
    r.run("add", "-A", "--", "scripts");
    // A symlink entry (mode 120000) is added straight to the index; no symlink needs to exist on this file system.
    const blob = execFileSync(git as string, ["hash-object", "-w", "--stdin"], { cwd: r.root, input: "target.json", encoding: "utf8" }).trim();
    r.run("update-index", "--add", "--cacheinfo", `120000,${blob},${BASELINE_DIRECTORY}/link.json`);
    r.run("commit", "--quiet", "-m", "link shard");
    expect(() => baselineAtRevision(git as string, r.root, "HEAD")).toThrow(/not trustworthy/);
  });
});

describe("buildShardFiles", () => {
  test("is the writer the equivalence proof compares against", () => {
    const files = buildShardFiles([a1, a2, b1]);
    expect([...files.keys()].sort()).toEqual([shardNameFor("app/a.tsx"), shardNameFor("app/b.tsx")].sort());
  });
});

describe("decodeShardName: the inverse of the encoding, closed over malformed names", () => {
  // S3403 (Sonar, baselineShards.mjs): the old guard read `body[i + 1]` and compared it to `undefined`. The two
  // refusals below are the guard's whole job: an escape with nothing, or the wrong thing, after it names no path.
  test.each([
    ["a trailing =", "a=.json"],
    ["= and nothing else", "=.json"],
    ["= before an upper-case letter", "=A.json"],
    ["= before a digit", "=1.json"],
    ["= before another escape", "=~41.json"],
    ["= before +", "=+.json"],
    ["= before a dot", "=..json"],
    ["a ~ with no digits", "a~.json"],
    ["a ~ with one digit", "a~4.json"],
    ["a ~ with a non-hex digit", "a~zz.json"],
    ["a ~ with upper-case hex", "a~4F.json"],
    ["a UTF-8 continuation byte on its own", "a~80.json"],
    ["a truncated multi-byte sequence", "a~e2~82.json"],
    ["a truncated multi-byte sequence followed by text", "~e2~82b.json"],
    ["a 0xff byte", "~ff.json"],
    ["a name with upper-case letters", "A.json"],
    ["a name that is not .json", "a.txt"],
    ["an empty body", ".json"],
  ])("%s decodes to null", (_label, name) => {
    expect(decodeShardName(name)).toBeNull();
  });

  test("a non-string is null", () => {
    expect(decodeShardName(undefined as unknown as string)).toBeNull();
  });

  test.each([
    ["a/b.tsx", "a+b.tsx.json"],
    ["Ab.tsx", "=ab.tsx.json"],
    ["a+b=c~d", "a~2bb~3dc~7ed.json"],
    ["app/(dashboard)/page.tsx", "app+~28dashboard~29+page.tsx.json"],
    ["\u20ac.ts", "~e2~82~ac.ts.json"],
    ["\u{1F600}/x", "~f0~9f~98~80+x.json"],
    ["=", "~3d.json"],
  ])("%j <-> %s", (file, name) => {
    expect(shardNameFor(file)).toBe(name);
    expect(decodeShardName(name)).toBe(file);
  });

  test("every printable ASCII character survives a round trip, and the name never holds an upper-case letter", () => {
    for (let code = 0x20; code < 0x7f; code++) {
      const file = `x${String.fromCodePoint(code)}y`;
      const name = shardNameFor(file);
      expect(name).toBe(name.toLowerCase());
      expect(decodeShardName(name)).toBe(file);
    }
  });

  test("an upper-case letter is written as = and its lower-case form (a code-point shift, not a case fold)", () => {
    expect(encodeFilePath("ABZ")).toBe("=a=b=z");
  });

  test.each([
    ["an empty path", ""],
    ["a non-string", 7],
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
  ])("%s is refused as a shard name", (_label, file) => {
    expect(() => encodeFilePath(file as string)).toThrow();
  });

  test("a name over the limit is refused", () => {
    expect(() => shardNameFor("a".repeat(MAX_SHARD_NAME_LENGTH))).toThrow(/over the 200 limit/);
  });
});

describe("canonicalJson", () => {
  test("sorts keys at every depth and is stable under key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("the shard loader: remaining fail-closed paths", () => {
  const directory = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cs-shard-load-")));
    created.push(dir);
    return dir;
  };

  test("an entry in the wrong shard whose file has no valid shard name is reported as such", () => {
    const longFile = `${"x".repeat(MAX_SHARD_NAME_LENGTH)}.tsx`;
    const misplaced = entry(longFile, 1);
    const text = JSON.stringify({ version: 1, file: "app/b.tsx", entries: [misplaced] }, null, 2) + "\n";
    const parsed = parseShardSet(new Map([[shardNameFor("app/b.tsx"), text]]));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.problem).toMatch(/belongs in \(no valid shard\), found in /);
  });

  test("a baseline path that cannot be read at all is a refusal naming the cause", () => {
    const loaded = loadShardedBaseline(`${directory()}\0bad`);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.problem).toMatch(/could not be read/);
  });

  test("a baseline path that is a file, not a directory, is a refusal", () => {
    const file = path.join(directory(), "plain.json");
    fs.writeFileSync(file, "{}");
    const loaded = loadShardedBaseline(file);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.problem).toMatch(/is a file, not a directory of shards|could not be read/);
  });

  test("a shard that cannot be read is a refusal, not a skipped shard", () => {
    const dir = writeBaselineDirectory(path.join(directory(), "shards"), [a1]);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("EIO: simulated read failure");
    });
    try {
      const loaded = loadShardedBaseline(dir);
      expect(loaded.ok).toBe(false);
      expect(loaded.ok ? "" : loaded.problem).toMatch(/shard .* could not be read \(EIO: simulated read failure\)/);
    } finally {
      spy.mockRestore();
    }
  });
});
