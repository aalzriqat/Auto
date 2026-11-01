// @vitest-environment node
/**
 * The sharded needs-evidence baseline (SCRUM-873): naming, canonical form, the fail-closed loader and the writer.
 * Every fail-closed case has its own test; "cannot load" is a failure, never a skip (SCRUM-760 ruling 3).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  BASELINE_DIRECTORY, EMPTY_MARKER_NAME, MAX_SHARD_NAME_LENGTH, buildShardFiles, canonicalJson, compareEntries, decodeShardName,
  encodeFilePath, loadShardedBaseline, parseShardSet, serializeEmptyMarker, serializeShard, shardNameFor, writeShardedBaseline,
} from "./baselineShards.mjs";
import { loadBaseline } from "./baseline.mjs";

/**
 * The skill-enforcement policy is a gate file this change must not edit, and it does not type-check under this
 * strict project, so it is run in a child process rather than imported (the parity check needs its answer only).
 */
function classifyInChildProcess(paths: string[]): { sensitive: string[]; behaviour: string[]; gate: string[]; code: string[] } {
  const policy = pathToFileURL(path.resolve("scripts/skillEnforcement/policy.mjs")).href;
  const script = `import(${JSON.stringify(policy)}).then((m) => process.stdout.write(JSON.stringify(m.classifyPaths(JSON.parse(process.argv[1])))))`;
  const child = spawnSync(process.execPath, ["-e", script, JSON.stringify(paths)], { encoding: "utf8", timeout: 30_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cs-shards-")));
  created.push(dir);
  return dir;
};

type Entry = Record<string, unknown>;
const entry = (file: string, line: number, over: Entry = {}): Entry => ({
  surface: "web", file, callSiteId: `${file}:${line}:13`, functionId: "orgSettings:upsert", contractPath: "orgId", kind: "TYPE_UNKNOWN",
  cause: "cause", fingerprint: "0123456789abcdef", multiplicity: 1, rationale: "rationale", issue: "SCRUM-711", expires: "2026-12-01", ...over,
});
const A = "app/(dashboard)/dashboard/page.tsx";
const B = "components/applications/cockpit/DealCockpit.tsx";

/** Write a directory of raw shard texts (so a test can plant a malformed one). */
function plant(files: Record<string, string>) {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const shardText = (file: string, entries: Entry[]) => serializeShard(file, entries);
const good = () => ({ [shardNameFor(A)]: shardText(A, [entry(A, 68), entry(A, 86)]), [shardNameFor(B)]: shardText(B, [entry(B, 10)]) });
const problemOf = (dir: string) => {
  const loaded = loadShardedBaseline(dir);
  expect(loaded.ok, "the loader accepted a baseline it must refuse").toBe(false);
  return loaded.ok ? "" : loaded.problem;
};

describe("shard naming is deterministic, injective and case-insensitive-safe", () => {
  test("worked examples", () => {
    expect(shardNameFor(A)).toBe("app+~28dashboard~29+dashboard+page.tsx.json");
    expect(shardNameFor(B)).toBe("components+applications+cockpit+=deal=cockpit.tsx.json");
    expect(shardNameFor("apps/mobile/src/features/workspace/VehicleDetailScreen.tsx")).toBe("apps+mobile+src+features+workspace+=vehicle=detail=screen.tsx.json");
  });

  test.each([A, B, "a+b=c~d/E.tsx", "app/[orgId]/x.tsx", "app/café/\u{1F600}.tsx", "UPPER", "x.json"])("round-trips %s", (file) => {
    const name = shardNameFor(file);
    expect(name).toBe(name.toLowerCase());
    expect(decodeShardName(name)).toBe(file);
  });

  test("paths that differ only by case, separator or an escape character get different names", () => {
    const paths = ["a/B.tsx", "a/b.tsx", "A/b.tsx", "a+b.tsx", "a/b.tsx", "a~2fb.tsx", "a=b.tsx", "a~3db.tsx", "a/=b.tsx", "a_b.tsx", "a-b.tsx"];
    const names = [...new Set(paths)].map(shardNameFor);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(new Set(paths).size);
  });

  test("a name that is not the encoding of a path decodes to nothing", () => {
    for (const name of ["Upper.json", "a b.json", "a~zz.json", "a~2.json", "a=.json", "a=1.json", "x.txt", ".json", "a/b.json", "a~ff.json"]) {
      expect(decodeShardName(name), name).toBeNull();
    }
  });

  test("refuses an empty path, a lone surrogate and a name over the length cap", () => {
    expect(() => encodeFilePath("")).toThrow(/non-empty/);
    expect(() => encodeFilePath("a/\ud800.tsx")).toThrow(/well-formed/);
    expect(() => shardNameFor("a/".repeat(MAX_SHARD_NAME_LENGTH))).toThrow(/over the 200 limit/);
  });
});

describe("shards have a stable order and formatting", () => {
  test("any input order serialises to the same bytes", () => {
    const entries = [entry(A, 100), entry(A, 9), entry(A, 9, { functionId: "a:b" }), entry(A, 68, { contractPath: "z" }), entry(A, 68)];
    const expected = serializeShard(A, entries);
    for (const permutation of [[...entries].reverse(), [entries[2], entries[0], entries[4], entries[1], entries[3]]]) {
      expect(serializeShard(A, permutation)).toBe(expected);
    }
    expect(compareEntries(entry(A, 9), entry(A, 100))).toBeLessThan(0);
    expect(JSON.parse(expected).entries.map((e: Entry) => e.callSiteId)).toEqual([9, 9, 68, 68, 100].map((n) => `${A}:${n}:13`));
  });

  test("regenerating from the loaded entries is byte-identical", () => {
    const dir = plant(good());
    const loaded = loadShardedBaseline(dir);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect([...buildShardFiles(loaded.entries)]).toEqual([...loaded.files].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  });

  test("line endings follow the shard being replaced", () => {
    const lf = serializeShard(A, [entry(A, 1)]);
    const crlf = serializeShard(A, [entry(A, 1)], lf.replace(/\n/g, "\r\n"));
    expect(crlf).toBe(lf.replace(/\n/g, "\r\n"));
    const dir = plant({ [shardNameFor(A)]: crlf });
    expect(loadShardedBaseline(dir).ok).toBe(true);
  });
});

describe("loader: fails closed", () => {
  test("loads a consistent set and returns the entries shard by shard", () => {
    const loaded = loadShardedBaseline(plant(good()));
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.entries.map((e) => e.callSiteId)).toEqual([`${A}:68:13`, `${A}:86:13`, `${B}:10:13`]);
  });

  test("a malformed shard (not JSON)", () => {
    const dir = plant({ ...good(), [shardNameFor("lib/x.ts")]: "{ not json" });
    expect(problemOf(dir)).toMatch(/not valid JSON/);
  });

  test.each([
    ["no entries array", JSON.stringify({ version: 1, file: A }, null, 2) + "\n", /no `entries` array/],
    ["an unknown key", JSON.stringify({ version: 1, file: A, entries: [entry(A, 1)], note: "x" }, null, 2) + "\n", /unknown key/],
    ["another version", JSON.stringify({ version: 2, file: A, entries: [entry(A, 1)] }, null, 2) + "\n", /version 2/],
    ["no entries", JSON.stringify({ version: 1, file: A, entries: [] }, null, 2) + "\n", /no entries/],
    ["an entry with no client file", JSON.stringify({ version: 1, file: A, entries: [{ surface: "web" }] }, null, 2) + "\n", /names no client file/],
    ["an entry that is not an object", JSON.stringify({ version: 1, file: A, entries: [7] }, null, 2) + "\n", /not an object/],
    ["a top level that is not an object", "[]\n", /not a JSON object/],
  ])("a malformed shard: %s", (_label, text, expected) => {
    expect(problemOf(plant({ [shardNameFor(A)]: text }))).toMatch(expected);
  });

  test("a shard that is not in canonical form is refused: reformatted, unsorted or without a final newline", () => {
    const entries = [entry(A, 1), entry(A, 2)];
    const canonical = shardText(A, entries);
    const reformatted = JSON.stringify(JSON.parse(canonical));
    const unsorted = JSON.stringify({ version: 1, file: A, entries: [...entries].reverse() }, null, 2) + "\n";
    for (const text of [reformatted, unsorted, canonical.trimEnd()]) {
      expect(problemOf(plant({ [shardNameFor(A)]: text }))).toMatch(/not in canonical form/);
    }
  });

  test("an entry in the wrong shard", () => {
    const wrong = JSON.stringify({ version: 1, file: A, entries: [entry(A, 1), entry(B, 10)] }, null, 2) + "\n";
    const message = problemOf(plant({ [shardNameFor(A)]: wrong }));
    expect(message).toMatch(/entry in the wrong shard/);
    expect(message).toContain(shardNameFor(B));
  });

  test("a duplicate entry across shards", () => {
    // The second shard is self-consistent about its own header but carries the first shard's entry.
    const dir = plant({
      [shardNameFor(A)]: shardText(A, [entry(A, 1)]),
      [shardNameFor(B)]: JSON.stringify({ version: 1, file: B, entries: [entry(A, 1)] }, null, 2) + "\n",
    });
    expect(problemOf(dir)).toMatch(/duplicate baseline entry/);
  });

  test("a duplicate entry inside one shard", () => {
    const dir = plant({ [shardNameFor(A)]: JSON.stringify({ version: 1, file: A, entries: [entry(A, 1), entry(A, 1)] }, null, 2) + "\n" });
    expect(problemOf(dir)).toMatch(/duplicate baseline entry/);
  });

  test.each([
    [".DS_Store"], ["README.md"], ["notes.txt"], ["UPPER.json"], ["app+page.tsx.json.bak"], [".app+page.tsx.json.0000.tmp"],
  ])("a stray or unknown file %s", (stray) => {
    expect(problemOf(plant({ ...good(), [stray]: "{}" }))).toMatch(/stray or unknown file/);
  });

  test("a file named like a shard of some other client file is judged as that shard, and refused on its content", () => {
    // notes.json is the valid shard name for a client file called "notes"; its content here is not a shard.
    expect(problemOf(plant({ ...good(), "notes.json": "{}" }))).toMatch(/shard notes\.json has version undefined/);
  });

  test("a stray subdirectory", () => {
    const dir = plant(good());
    fs.mkdirSync(path.join(dir, "nested"));
    expect(problemOf(dir)).toMatch(/not a regular file/);
  });

  test("a shard whose name is not the encoding of the file it declares", () => {
    const dir = plant({ [shardNameFor(B)]: shardText(A, [entry(A, 1)]) });
    const message = problemOf(dir);
    expect(message).toMatch(/declares client file/);
    expect(message).toMatch(/entry in the wrong shard/);
  });

  test("an empty directory is not an empty baseline", () => {
    expect(problemOf(tempDir())).toMatch(/empty directory is not an empty baseline/);
  });

  test("an absent directory, and a file where the directory belongs, are refused", () => {
    expect(problemOf(path.join(tempDir(), "missing"))).toMatch(/absent; an absent baseline is not an empty one/);
    const dir = tempDir();
    const asFile = path.join(dir, "baseline.json");
    fs.writeFileSync(asFile, "{}");
    expect(problemOf(asFile)).toMatch(/is a file, not a directory of shards/);
  });

  test("the empty marker is an explicit empty baseline only when it stands alone", () => {
    const alone = loadShardedBaseline(plant({ [EMPTY_MARKER_NAME]: serializeEmptyMarker() }));
    expect(alone.ok && alone.entries).toEqual([]);
    expect(problemOf(plant({ ...good(), [EMPTY_MARKER_NAME]: serializeEmptyMarker() }))).toMatch(/declares an empty baseline but shards are present/);
    expect(problemOf(plant({ [EMPTY_MARKER_NAME]: "{}\n" }))).toMatch(/not the canonical empty-baseline marker/);
  });

  test("reports every problem, not only the first", () => {
    const result = parseShardSet(new Map([["notes.txt", "{}"], [shardNameFor(A), "{ no"]]));
    expect(result.ok ? [] : result.problems).toHaveLength(2);
  });

  test("loadBaseline (the monitor's reader) refuses the same inputs and passes a good set", () => {
    expect(loadBaseline(plant(good()))).toMatchObject({ ok: true });
    expect(loadBaseline(tempDir())).toMatchObject({ ok: false });
    expect(loadBaseline(plant({ ...good(), "stray.txt": "x" }))).toMatchObject({ ok: false });
  });
});

describe("writer", () => {
  const snapshot = (dir: string) => {
    const loaded = loadShardedBaseline(dir);
    if (!loaded.ok) throw new Error(loaded.problem);
    return loaded;
  };

  test("writes only the shards that changed, and removes a shard whose file has no entries left", () => {
    const dir = plant(good());
    const before = snapshot(dir);
    const untouched = path.join(dir, shardNameFor(B));
    const marker = fs.statSync(untouched).mtimeMs;
    const entries = before.entries.filter((e) => e.file === A).map((e, i) => (i === 0 ? { ...e, expires: "2027-01-01" } : e));
    const result = writeShardedBaseline(dir, entries, { before: before.files, root: dir });
    expect(result.written).toEqual([shardNameFor(A)]);
    expect(result.removed).toEqual([shardNameFor(B)]);
    expect(fs.existsSync(untouched)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual([shardNameFor(A)]);
    expect(marker).toBeGreaterThan(0);
    expect(snapshot(dir).entries[0].expires).toBe("2027-01-01");
  });

  test("an unchanged set rewrites nothing", () => {
    const dir = plant(good());
    const before = snapshot(dir);
    const result = writeShardedBaseline(dir, before.entries, { before: before.files, root: dir });
    expect(result).toEqual({ written: [], removed: [], unchanged: 2 });
  });

  test("refuses when the directory changed since it was read", () => {
    const dir = plant(good());
    const before = snapshot(dir);
    fs.appendFileSync(path.join(dir, shardNameFor(B)), " ");
    expect(() => writeShardedBaseline(dir, before.entries, { before: before.files, root: dir })).toThrow(/changed while checking/);
  });

  test("refuses a directory outside the root, an entry that names no file, a duplicate, and an empty baseline without allowEmpty", () => {
    const dir = plant(good());
    const before = snapshot(dir);
    expect(() => writeShardedBaseline(dir, before.entries, { before: before.files, root: tempDir() })).toThrow(/outside the repository root/);
    expect(() => writeShardedBaseline(dir, [{ surface: "web" }], { before: before.files, root: dir })).toThrow(/names no client file/);
    expect(() => writeShardedBaseline(dir, [...before.entries, before.entries[0]], { before: before.files, root: dir })).toThrow(/would not load.*duplicate/);
    expect(() => writeShardedBaseline(dir, [], { before: before.files, root: dir })).toThrow(/empty baseline/);
    const empty = writeShardedBaseline(dir, [], { before: before.files, root: dir, allowEmpty: true });
    expect(empty.written).toEqual([EMPTY_MARKER_NAME]);
    expect(snapshot(dir).entries).toEqual([]);
  });

  test("creates the directory, leaves no temporary file behind, and keeps CRLF shards CRLF", () => {
    const root = tempDir();
    const dir = path.join(root, "new-baseline");
    writeShardedBaseline(dir, [entry(A, 1)], { before: new Map(), root });
    const name = shardNameFor(A);
    const crlf = fs.readFileSync(path.join(dir, name), "utf8").replace(/\n/g, "\r\n");
    fs.writeFileSync(path.join(dir, name), crlf);
    const before = snapshot(dir);
    writeShardedBaseline(dir, [{ ...entry(A, 1), expires: "2027-01-01" }], { before: before.files, root });
    expect(fs.readFileSync(path.join(dir, name), "utf8")).toContain("\r\n");
    expect(fs.readdirSync(dir)).toEqual([name]);
  });
});

describe("canonicalJson", () => {
  test("is independent of key order and distinguishes values", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});

describe("the committed baseline", () => {
  const directory = path.resolve(BASELINE_DIRECTORY);

  test("loads, holds every entry once, and is byte-for-byte what the writer would produce", () => {
    const loaded = loadShardedBaseline(directory);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.entries.length).toBeGreaterThan(0);
    const normalise = (text: string) => text.replace(/\r\n/g, "\n");
    const rebuilt = buildShardFiles(loaded.entries);
    expect([...rebuilt.keys()]).toEqual([...loaded.files.keys()].sort((a, b) => (a < b ? -1 : 1)));
    for (const [name, text] of rebuilt) expect(normalise(loaded.files.get(name) ?? ""), name).toBe(text);
  });

  test("shard names stay unique on a case-insensitive file system and well under the length limit", () => {
    const names = fs.readdirSync(directory);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(Math.max(...names.map((n) => n.length))).toBeLessThanOrEqual(MAX_SHARD_NAME_LENGTH);
  });

  test("the single-file layout is gone", () => {
    expect(fs.existsSync(path.resolve("scripts/contractSkew/needs-evidence-baseline.json"))).toBe(false);
  });

  test("the shards are in the same gate class as the file they replaced (SCRUM-760: no path escapes a required check)", () => {
    const classes = classifyInChildProcess;
    const old = classes(["scripts/contractSkew/needs-evidence-baseline.json"]);
    const shards = classes(fs.readdirSync(directory).map((name) => `${BASELINE_DIRECTORY}/${name}`));
    expect({ sensitive: shards.sensitive, behaviour: shards.behaviour, gate: shards.gate, code: shards.code }).toEqual(old);
  });
});
