import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { contractFingerprint, evaluateBaseline, identityOf, loadBaseline, unprovenFrom } from "./baseline.mjs";

const spec = (fields: Record<string, unknown> = { x: { fieldType: { type: "string" }, optional: false } }) => ({
  functions: [
    {
      identifier: "a:b",
      functionType: "Query",
      visibility: { kind: "public" },
      args: { type: "object", value: fields },
    },
  ],
});

const finding = (over: Record<string, unknown> = {}) => ({
  identifier: "a:b",
  path: "x",
  severity: "SHAPE_UNKNOWN",
  detail: "cause one",
  file: "app/page.tsx",
  line: 10,
  siteId: "site-1",
  surface: "web",
  ...over,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-baseline-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text);
  return file;
};

describe("contractFingerprint key ordering", () => {
  test("reordering a validator's keys does not change the fingerprint", () => {
    const ab = spec({
      a: { fieldType: { type: "string" }, optional: false },
      b: { fieldType: { type: "number" }, optional: true },
    });
    const ba = spec({
      b: { fieldType: { type: "number" }, optional: true },
      a: { fieldType: { type: "string" }, optional: false },
    });
    expect(contractFingerprint(ab, "a:b", "a")).toBe(contractFingerprint(ba, "a:b", "a"));
    // Whole-argument scope (path names no field) exercises the same ordering.
    expect(contractFingerprint(ab, "a:b", "1bad")).toBe(contractFingerprint(ba, "a:b", "1bad"));
  });

  test("a different validator under the same path changes it (control)", () => {
    const string = spec({ x: { fieldType: { type: "string" }, optional: false } });
    const number = spec({ x: { fieldType: { type: "number" }, optional: false } });
    expect(contractFingerprint(string, "a:b", "x")).not.toBe(contractFingerprint(number, "a:b", "x"));
  });

  test("an unknown function hashes as absent rather than throwing", () => {
    expect(contractFingerprint(spec(), "no:such", "x")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("arrays, null and non-object values serialise without throwing", () => {
    const odd = spec({ x: { fieldType: { type: "array", value: [null, 1, "s", { k: 1 }] }, optional: false } });
    expect(contractFingerprint(odd, "a:b", "x")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("keys that differ only by case order by code unit, not by locale", () => {
    // Under localeCompare "a" < "B"; by code unit "B" (66) < "a" (97). The two
    // specs spell the same keys in opposite orders and must still agree.
    const one = spec({ B: { fieldType: { type: "string" }, optional: false }, a: { fieldType: { type: "string" }, optional: false } });
    const two = spec({ a: { fieldType: { type: "string" }, optional: false }, B: { fieldType: { type: "string" }, optional: false } });
    expect(contractFingerprint(one, "a:b", "B")).toBe(contractFingerprint(two, "a:b", "B"));
  });
});

describe("unprovenFrom", () => {
  test("aggregates by identity, counting multiplicity and keeping distinct causes", () => {
    const out = unprovenFrom([finding(), finding(), finding({ detail: "cause two" }), finding({ detail: "cause one" })], spec());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      surface: "web",
      file: "app/page.tsx",
      callSiteId: "site-1",
      functionId: "a:b",
      contractPath: "x",
      kind: "SHAPE_UNKNOWN",
      multiplicity: 4,
      cause: "cause one || cause two",
    });
  });

  test("defaults surface to unknown and callSiteId to file:line", () => {
    const [entry] = unprovenFrom([finding({ surface: undefined, siteId: undefined })], spec());
    expect(entry.surface).toBe("unknown");
    expect(entry.callSiteId).toBe("app/page.tsx:10");
  });

  test("different paths stay separate findings", () => {
    expect(unprovenFrom([finding(), finding({ path: "y" })], spec())).toHaveLength(2);
  });
});

describe("loadBaseline", () => {
  test("an absent file is a problem, not an empty baseline", () => {
    const result = loadBaseline(path.join(tmp, "missing.json"));
    expect(result).toMatchObject({ ok: false });
    expect((result as { problem: string }).problem).toContain("is absent");
  });

  test("an unreadable path (a directory) is reported as unreadable", () => {
    const result = loadBaseline(tmp);
    expect(result).toMatchObject({ ok: false });
    expect((result as { problem: string }).problem).toContain("could not be read");
  });

  test("invalid JSON is a problem", () => {
    const result = loadBaseline(write("bad.json", "{nope"));
    expect((result as { problem: string }).problem).toContain("is not valid JSON");
  });

  test.each([["null", "null"], ["a string", '"x"'], ["no entries array", '{"entries": 3}']])(
    "%s has no entries array",
    (_name, text) => {
      const result = loadBaseline(write("shape.json", text));
      expect((result as { problem: string }).problem).toContain("no `entries` array");
    },
  );

  test("a well-formed file loads its entries", () => {
    expect(loadBaseline(write("ok.json", '{"entries":[{"a":1}]}'))).toEqual({ ok: true, entries: [{ a: 1 }] });
  });
});

describe("evaluateBaseline", () => {
  const unproven = () => unprovenFrom([finding()], spec());
  const entryFor = (over: Record<string, unknown> = {}) => ({
    ...unproven()[0],
    rationale: "reviewed",
    issue: "SCRUM-1",
    expires: "2999-01-01",
    ...over,
  });
  const run = (entries: unknown[], found = unproven(), now = new Date("2026-10-04T00:00:00Z")) =>
    evaluateBaseline(found, { ok: true, entries }, now);

  test("a matching, unexpired entry is accepted without drift", () => {
    expect(run([entryFor()])).toEqual({ drift: false, problems: [], matched: 1 });
  });

  test("a baseline that failed to load is drift carrying the load problem", () => {
    expect(evaluateBaseline([], { ok: false, problem: "boom" })).toEqual({ drift: true, problems: ["boom"], matched: 0 });
  });

  test("a new unproven path with no entry is drift", () => {
    const result = run([]);
    expect(result.drift).toBe(true);
    expect(result.problems[0]).toContain("new unproven path with no baseline entry");
  });

  test("an entry no longer reported is drift (a stale entry would pre-approve its return)", () => {
    const result = run([entryFor()], []);
    expect(result.problems[0]).toContain("no longer reported");
    expect(result.matched).toBe(0);
  });

  test("an expired entry is drift, and the finding is not silently accepted", () => {
    const result = run([entryFor({ expires: "2026-10-03" })]);
    expect(result.problems.some((p) => p.startsWith("expired baseline entry"))).toBe(true);
    expect(result.matched).toBe(0);
  });

  test("an entry that expires today is still valid", () => {
    expect(run([entryFor({ expires: "2026-10-04" })]).drift).toBe(false);
  });

  test("a changed fingerprint means the review no longer applies", () => {
    expect(run([entryFor({ fingerprint: "0000000000000000" })]).problems[0]).toContain("contract changed under a baselined path");
  });

  test("a changed cause means the review no longer applies", () => {
    expect(run([entryFor({ cause: "different" })]).problems[0]).toContain("contract changed under a baselined path");
  });

  test("a changed multiplicity is drift", () => {
    expect(run([entryFor({ multiplicity: 2 })]).problems[0]).toContain("multiplicity changed (2 reviewed, 1 now)");
  });

  test("a duplicate entry is reported once and the first is kept", () => {
    const result = run([entryFor(), entryFor()]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("duplicate baseline entry");
    expect(result.matched).toBe(1);
  });

  test.each([
    ["not an object", null, "not an object"],
    ["missing a required text field", entryFor({ rationale: "  " }), "missing or empty rationale"],
    ["an unknown kind", entryFor({ kind: "WHATEVER" }), "kind must be SHAPE_UNKNOWN or TYPE_UNKNOWN"],
    ["a zero multiplicity", entryFor({ multiplicity: 0 }), "multiplicity must be a positive integer"],
    ["a fractional multiplicity", entryFor({ multiplicity: 1.5 }), "multiplicity must be a positive integer"],
    ["a non-date expiry", entryFor({ expires: "tomorrow" }), "expires must be YYYY-MM-DD"],
    ["an impossible date", entryFor({ expires: "2026-13-45" }), "expires must be YYYY-MM-DD"],
  ])("a malformed entry (%s) is reported and not trusted", (_name, entry, expected) => {
    const result = run([entry]);
    expect(result.drift).toBe(true);
    expect(result.problems[0]).toContain("malformed baseline entry #1");
    expect(result.problems[0]).toContain(expected);
    // Not trusted means it does not pre-approve the real finding either.
    expect(result.problems.some((p) => p.startsWith("new unproven path"))).toBe(true);
    expect(result.matched).toBe(0);
  });
});

describe("identityOf", () => {
  test("ignores cause and fingerprint but not the call site", () => {
    const base = unproven()[0];
    expect(identityOf({ ...base, cause: "z", fingerprint: "z" })).toBe(identityOf(base));
    expect(identityOf({ ...base, callSiteId: "other" })).not.toBe(identityOf(base));
  });
  function unproven() {
    return unprovenFrom([finding()], spec());
  }
});
