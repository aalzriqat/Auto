import { describe, expect, test } from "vitest";

import { digestRulingText as scriptDigest, upsertRuling } from "./refreshRulings.mjs";
import { digestRulingText, validateRulingSnapshot } from "./scenarioRecord";

describe("refreshRulings (snapshot upsert)", () => {
  test("its digest is identical to the validator's, so a refreshed entry is never 'drifted'", () => {
    const text = "  FC transfers\n the FULL   approved amount ";
    expect(scriptDigest(text)).toBe(digestRulingText(text));
  });

  test("writes id + digest + date only, never the ruling text", () => {
    const next = upsertRuling([], { id: "SCRUM-407#c21031", text: "secret ruling words", date: "2026-10-07" });
    expect(Object.keys(next[0]).sort()).toEqual(["date", "digest", "id"]);
    expect(JSON.stringify(next)).not.toContain("secret");
    expect(validateRulingSnapshot(next)).toEqual([]);
  });

  test("re-running replaces the entry (no duplicate) and keeps the snapshot sorted", () => {
    const a = upsertRuling([], { id: "SCRUM-9#c2", text: "b", date: "2026-10-07" });
    const b = upsertRuling(a, { id: "SCRUM-1#c1", text: "a", date: "2026-10-07" });
    const c = upsertRuling(b, { id: "SCRUM-9#c2", text: "b changed", date: "2026-10-08" });
    expect(c.map((e: { id: string }) => e.id)).toEqual(["SCRUM-1#c1", "SCRUM-9#c2"]);
    expect(c[1].digest).toBe(digestRulingText("b changed"));
  });

  test("accepts an issue-description ruling id, and the validator agrees", () => {
    const next = upsertRuling([], { id: "SCRUM-413#description", text: "scope text", date: "2026-10-08" });
    expect(next[0].id).toBe("SCRUM-413#description");
    expect(validateRulingSnapshot(next)).toEqual([]);
    expect(() => upsertRuling([], { id: "SCRUM-413#descr", text: "x", date: "2026-10-08" })).toThrow(/ruling id/);
    expect(validateRulingSnapshot([{ id: "SCRUM-413#descr", digest: next[0].digest, date: "2026-10-08" }])).not.toEqual([]);
  });

  test("refuses a malformed id, bad date or empty text", () => {
    expect(() => upsertRuling([], { id: "407-c21031", text: "x", date: "2026-10-07" })).toThrow(/ruling id/);
    expect(() => upsertRuling([], { id: "SCRUM-1#c1", text: "x", date: "today" })).toThrow(/date/);
    expect(() => upsertRuling([], { id: "SCRUM-1#c1", text: "  ", date: "2026-10-07" })).toThrow(/empty/);
  });
});
