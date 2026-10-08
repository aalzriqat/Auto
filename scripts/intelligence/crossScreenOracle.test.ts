import { describe, expect, it } from "vitest";
import { FACTS, allAgree, fingerprint, judge, judgeAll, type Fact, type Reading } from "./crossScreenOracle";

const fact = (id: string) => FACTS.find((f) => f.id === id) as Fact;
const r = (surface: string, value: number | null): Reading => ({ surface, value });

describe("crossScreenOracle", () => {
  it("agrees when two screens show the same count", () => {
    const v = judge(fact("notifications.unread"), [r("nav.bellBadge", 12), r("notifications.unreadRows", 12)]);
    expect(v.result).toBe("AGREE");
  });

  it("flags two screens showing different counts, naming both", () => {
    const v = judge(fact("notifications.unread"), [r("nav.bellBadge", 12), r("notifications.unreadRows", 11)]);
    expect(v).toMatchObject({ result: "DISAGREE", expected: 12 });
    expect(v.result === "DISAGREE" && v.observed.map((o) => o.surface)).toEqual(["nav.bellBadge", "notifications.unreadRows"]);
  });

  it("treats an unreadable surface as a failure, never a pass (SCRUM-760 R4)", () => {
    const v = judge(fact("notifications.unread"), [r("nav.bellBadge", 12), r("notifications.unreadRows", null)]);
    expect(v).toEqual({ fact: "notifications.unread", result: "UNREADABLE", missing: ["notifications.unreadRows"] });
    expect(allAgree([v])).toBe(false);
  });

  it("treats an absent surface, NaN and a negative count as unreadable", () => {
    expect(judge(fact("notifications.unread"), [r("nav.bellBadge", 1)]).result).toBe("UNREADABLE");
    expect(judge(fact("notifications.unread"), [r("nav.bellBadge", NaN), r("notifications.unreadRows", 1)]).result).toBe("UNREADABLE");
    expect(judge(fact("notifications.unread"), [r("nav.bellBadge", -1), r("notifications.unreadRows", -1)]).result).toBe("UNREADABLE");
  });

  it("zero on both screens agrees: an empty org is not a disagreement", () => {
    expect(judge(fact("notifications.unread"), [r("nav.bellBadge", 0), r("notifications.unreadRows", 0)]).result).toBe("AGREE");
  });

  it("flags tiles that add up to more than the headline, but not fewer (some stages have no tile)", () => {
    const f = fact("leads.tilesWithinTotal");
    expect(judge(f, [r("dashboard.totalLeads", 5), r("dashboard.tileNew", 2), r("dashboard.tileQualified", 2)]).result).toBe("AGREE");
    expect(judge(f, [r("dashboard.totalLeads", 3), r("dashboard.tileNew", 2), r("dashboard.tileQualified", 2)]).result).toBe("DISAGREE");
  });

  it("a fact with no readings at all is unreadable, so a skipped screen cannot pass", () => {
    const vs = judgeAll([]);
    expect(vs).toHaveLength(FACTS.length);
    expect(vs.every((v) => v.result === "UNREADABLE")).toBe(true);
    expect(allAgree(vs)).toBe(false);
  });

  it("fingerprints are stable across order and values, and distinguish results", () => {
    const a = judge(fact("notifications.unread"), [r("nav.bellBadge", 3), r("notifications.unreadRows", 2)]);
    const b = judge(fact("notifications.unread"), [r("notifications.unreadRows", 5), r("nav.bellBadge", 1)]);
    expect(a.result).toBe("DISAGREE");
    expect(b.result).toBe("DISAGREE");
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint({ fact: "notifications.unread", result: "UNREADABLE", missing: ["nav.bellBadge"] }));
  });

  it("an empty verdict list is never a pass", () => {
    expect(allAgree([])).toBe(false);
  });
  it("every fact names at least two surfaces, unique within the fact", () => {
    for (const f of FACTS) {
      expect(f.surfaces.length).toBeGreaterThanOrEqual(2);
      expect(new Set(f.surfaces.map((s) => s.id)).size).toBe(f.surfaces.length);
    }
  });
});