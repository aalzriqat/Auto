import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_REFUSAL,
  POSTED_HISTORY_REFUSAL,
  TENANT_REFUSAL,
  evaluateListCompleteness,
  evaluateReversalReconciliation,
  judgeRefusedAttempt,
  judgeTenantRead,
  judgeUnchanged,
  probe,
  type LedgerSnapshot,
  type ProbeOutcome,
} from "./browserSwarmBoundaryOracle";

const live = new AbortController().signal;

/**
 * SCRUM-350 — the pure judgements behind the TENANT_ESCAPE, AUTHORIZATION_ABUSE,
 * COMPLETENESS_BOUNDARY and LIFECYCLE_REVERSAL attacks. Every verdict here is
 * decided from backend state or from a backend refusal; none of them can pass
 * on a missing, unclassified or lapsed observation.
 */
describe("probe classification", () => {
  it("records an accepted call with its value", async () => {
    await expect(probe(async () => ({ ok: 1 }), AUTHORIZATION_REFUSAL, live)).resolves.toEqual({
      kind: "ACCEPTED",
      value: { ok: 1 },
    });
  });

  it.each([
    ["a structured permission refusal", { code: "FORBIDDEN", message: "Forbidden: Missing required permissions: edit:org" }],
    ["a structured membership refusal", { code: "UNAUTHORIZED", message: "Unauthorized: You are not a member of this organization." }],
    ["a plain-string owner refusal", "Forbidden: Only the organization owner can perform this action."],
    ["a plain-string self-change refusal", "You cannot change your own role. Ask an owner to change it for you."],
  ])("treats %s as an authorization refusal", async (_name, data) => {
    const outcome = await probe(
      async () => {
        throw new ConvexError(data as never);
      },
      AUTHORIZATION_REFUSAL,
      live,
    );
    expect(outcome.kind).toBe("REFUSED");
  });

  it("does not treat a rate limit, a validation failure or a not-found as an authorization refusal", async () => {
    for (const message of [
      "Rate limit exceeded. Try again in 12s",
      "Invalid input: name is required",
      "Organization not found.",
    ]) {
      const outcome = await probe(
        async () => {
          throw new ConvexError(message);
        },
        AUTHORIZATION_REFUSAL,
        live,
      );
      expect(outcome).toEqual({ kind: "UNCLASSIFIED", message });
    }
  });

  it("accepts a not-found refusal only for tenant probes", async () => {
    const outcome = await probe(
      async () => {
        throw new ConvexError("Customer not found in this organization.");
      },
      TENANT_REFUSAL,
      live,
    );
    expect(outcome.kind).toBe("REFUSED");
  });

  it("recognises the posted-history refusals the expense mutations raise", () => {
    expect(POSTED_HISTORY_REFUSAL.test("Posted expenses are locked. Use a correction or reversal workflow before changing accounting fields.")).toBe(true);
    expect(POSTED_HISTORY_REFUSAL.test("Posted expenses cannot be deleted. Use a reversal workflow instead.")).toBe(true);
    expect(POSTED_HISTORY_REFUSAL.test("Expense not found.")).toBe(false);
    // A broken attacker account is not a tenant refusal.
    expect(TENANT_REFUSAL.test("User not found in the database. Please contact support.")).toBe(false);
    expect(TENANT_REFUSAL.test("Membership role not found or corrupted.")).toBe(false);
  });

  it("reports a lapsed harness session instead of a refusal", async () => {
    const outcome = await probe(
      async () => {
        throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
      },
      AUTHORIZATION_REFUSAL,
      live,
    );
    expect(outcome).toEqual({ kind: "LAPSED" });
  });

  it("never reads a transport failure as a refusal", async () => {
    const outcome = await probe(
      async () => {
        throw new TypeError("fetch failed");
      },
      AUTHORIZATION_REFUSAL,
      live,
    );
    expect(outcome).toEqual({ kind: "UNCLASSIFIED", message: "fetch failed" });
  });

  it("rethrows instead of classifying once the mission is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    await expect(
      probe(
        async () => {
          throw new ConvexError("Forbidden: nope");
        },
        AUTHORIZATION_REFUSAL,
        controller.signal,
      ),
    ).rejects.toThrow("mission timed out");
  });
});

describe("judgeRefusedAttempt", () => {
  it("proves a breach when the forbidden call was accepted", () => {
    const verdict = judgeRefusedAttempt("rename organization", { kind: "ACCEPTED", value: null });
    expect(verdict.violations).toEqual(["rename organization was accepted"]);
    expect(verdict.unjudged).toEqual([]);
  });

  it("is clean on an authorization refusal", () => {
    expect(judgeRefusedAttempt("x", { kind: "REFUSED", message: "Forbidden" })).toEqual({
      violations: [],
      unjudged: [],
    });
  });

  it.each<ProbeOutcome>([
    { kind: "LAPSED" },
    { kind: "UNCLASSIFIED", message: "Rate limit exceeded. Try again in 3s" },
  ])("leaves %j unjudged, never a pass", (outcome) => {
    const verdict = judgeRefusedAttempt("x", outcome);
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toHaveLength(1);
  });
});

describe("judgeTenantRead", () => {
  const canaries = ["canary-lastname-1", "canary@example.test"];

  it("proves a leak when a foreign resource comes back", () => {
    const verdict = judgeTenantRead(
      "customers.search",
      { kind: "ACCEPTED", value: [{ lastName: "canary-lastname-1" }] },
      canaries,
    );
    expect(verdict.violations).toEqual(["customers.search returned data that belongs to the other organization"]);
  });

  it("accepts an empty answer and a refusal", () => {
    expect(judgeTenantRead("a", { kind: "ACCEPTED", value: [] }, canaries)).toEqual({
      violations: [],
      unjudged: [],
    });
    expect(judgeTenantRead("a", { kind: "REFUSED", message: "Unauthorized" }, canaries)).toEqual({
      violations: [],
      unjudged: [],
    });
  });

  it("matches a canary anywhere in a nested response", () => {
    const verdict = judgeTenantRead(
      "list",
      { kind: "ACCEPTED", value: { page: [{ a: { b: ["xx canary@example.test xx"] } }] } },
      canaries,
    );
    expect(verdict.violations).toHaveLength(1);
  });

  it("refuses to judge with no canary, because nothing could be found", () => {
    const verdict = judgeTenantRead("a", { kind: "ACCEPTED", value: [] }, []);
    expect(verdict.unjudged).toHaveLength(1);
  });

  it("leaves a lapse or unclassified failure unjudged", () => {
    expect(judgeTenantRead("a", { kind: "LAPSED" }, canaries).unjudged).toHaveLength(1);
    expect(
      judgeTenantRead("a", { kind: "UNCLASSIFIED", message: "boom" }, canaries).unjudged,
    ).toHaveLength(1);
  });
});

describe("judgeUnchanged", () => {
  it("proves a change", () => {
    expect(judgeUnchanged("organization name", { name: "A" }, { name: "B" }).violations).toEqual([
      'organization name changed from {"name":"A"} to {"name":"B"}',
    ]);
  });

  it("is clean when nothing moved, whatever the key order", () => {
    expect(judgeUnchanged("x", { a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({ violations: [], unjudged: [] });
  });

  it("cannot judge a state that was never read", () => {
    expect(judgeUnchanged("x", undefined, { a: 1 }).unjudged).toHaveLength(1);
    expect(judgeUnchanged("x", { a: 1 }, undefined).unjudged).toHaveLength(1);
  });
});

describe("evaluateListCompleteness", () => {
  const ids = (count: number, prefix = "c") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const base = {
    // 30 customers exist; the three seeded ones are the newest, past the 25-row first page.
    authorityOrder: [...ids(27, "old"), "s0", "s1", "s2"],
    seededIds: ["s0", "s1", "s2"],
    firstPageSize: 25,
  };

  it("passes when the search shows every matching row", () => {
    expect(
      evaluateListCompleteness({ ...base, uiIds: ["s0", "s1", "s2"], partialDisclosed: false }),
    ).toEqual({ violations: [], unjudged: [] });
  });

  it("proves a silent truncation when the page claims completeness but drops rows past the first page", () => {
    const verdict = evaluateListCompleteness({ ...base, uiIds: ["s0"], partialDisclosed: false });
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatch(/omitted 2 of 3 matching rows/);
    expect(verdict.unjudged).toEqual([]);
  });

  it("does not call a disclosed partial result silent", () => {
    const verdict = evaluateListCompleteness({ ...base, uiIds: ["s0"], partialDisclosed: true });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toHaveLength(1);
  });

  it("cannot judge when no seeded row lies beyond the first page", () => {
    const verdict = evaluateListCompleteness({
      authorityOrder: ["s0", "s1", "s2"],
      seededIds: ["s0", "s1", "s2"],
      firstPageSize: 25,
      uiIds: ["s0"],
      partialDisclosed: false,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged[0]).toMatch(/first page/);
  });

  it("cannot judge when the authority read did not return the seeded rows", () => {
    const verdict = evaluateListCompleteness({
      ...base,
      authorityOrder: ids(27, "old"),
      uiIds: [],
      partialDisclosed: false,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged[0]).toMatch(/authority/);
  });

  it("cannot judge an empty seed", () => {
    expect(
      evaluateListCompleteness({ ...base, seededIds: [], uiIds: [], partialDisclosed: false }).unjudged,
    ).toHaveLength(1);
  });
});

describe("evaluateReversalReconciliation", () => {
  const reconcile = (input: { posted: LedgerSnapshot; reversed: LedgerSnapshot; replayed: LedgerSnapshot }) =>
    evaluateReversalReconciliation({ ...input, seededAmount: 53, expectedCurrency: "JOD" });
  const originalLines = [
    { accountId: "acc-expense", debitMinor: 53_000, creditMinor: 0, scale: 3, currency: "JOD" },
    { accountId: "acc-cash", debitMinor: 0, creditMinor: 53_000, scale: 3, currency: "JOD" },
  ];
  const mirrorLines = [
    { accountId: "acc-expense", debitMinor: 0, creditMinor: 53_000, scale: 3, currency: "JOD" },
    { accountId: "acc-cash", debitMinor: 53_000, creditMinor: 0, scale: 3, currency: "JOD" },
  ];
  const postedEvent = {
    id: "ev-1",
    eventType: "EXPENSE_POSTED",
    status: "POSTED",
    reversalOfEventId: null,
    reversedByEventId: null,
    journalEntryId: "je-1",
  };
  const posted: LedgerSnapshot = { events: [postedEvent], journals: { "je-1": originalLines } };
  const reversalEvent = {
    id: "ev-2",
    eventType: "JOURNAL_REVERSAL",
    status: "POSTED",
    reversalOfEventId: "ev-1",
    reversedByEventId: null,
    journalEntryId: "je-2",
  };
  const reversed: LedgerSnapshot = {
    events: [{ ...postedEvent, status: "REVERSED", reversedByEventId: "ev-2" }, reversalEvent],
    journals: { "je-1": originalLines, "je-2": mirrorLines },
  };

  it("passes a canonical, linked, mirrored reversal that is idempotent", () => {
    expect(reconcile({ posted, reversed, replayed: reversed })).toEqual({
      violations: [],
      unjudged: [],
    });
  });

  it("proves a rewrite when the original journal lines changed", () => {
    const rewritten: LedgerSnapshot = {
      ...reversed,
      journals: {
        "je-1": [{ ...originalLines[0]!, debitMinor: 99_000 }, originalLines[1]!],
        "je-2": mirrorLines,
      },
    };
    const verdict = reconcile({ posted, reversed: rewritten, replayed: rewritten });
    expect(verdict.violations.join(" | ")).toMatch(/posted journal lines were rewritten/);
  });

  it("proves a rewrite when the original event is gone", () => {
    const erased: LedgerSnapshot = { events: [reversalEvent], journals: { "je-2": mirrorLines } };
    const verdict = reconcile({ posted, reversed: erased, replayed: erased });
    expect(verdict.violations.join(" | ")).toMatch(/original posted event .* is gone/);
  });

  it("proves an unlinked reversal", () => {
    const unlinked: LedgerSnapshot = {
      ...reversed,
      events: [{ ...postedEvent, status: "REVERSED", reversedByEventId: null }, reversalEvent],
    };
    const verdict = reconcile({ posted, reversed: unlinked, replayed: unlinked });
    expect(verdict.violations.join(" | ")).toMatch(/not linked/);
  });

  it("proves a reversal that does not mirror the original (amount)", () => {
    const wrong: LedgerSnapshot = {
      ...reversed,
      journals: {
        "je-1": originalLines,
        "je-2": [{ ...mirrorLines[0]!, creditMinor: 40_000 }, mirrorLines[1]!],
      },
    };
    const verdict = reconcile({ posted, reversed: wrong, replayed: wrong });
    expect(verdict.violations.join(" | ")).toMatch(/does not mirror/);
  });

  it("proves a reversal that does not mirror the original (same side, not swapped)", () => {
    const sameSide: LedgerSnapshot = {
      ...reversed,
      journals: { "je-1": originalLines, "je-2": originalLines },
    };
    const verdict = reconcile({ posted, reversed: sameSide, replayed: sameSide });
    expect(verdict.violations.join(" | ")).toMatch(/does not mirror/);
  });

  it("proves a second reversal footprint after the replay", () => {
    const doubled: LedgerSnapshot = {
      events: [
        ...reversed.events,
        { ...reversalEvent, id: "ev-3", journalEntryId: "je-3" },
      ],
      journals: { ...reversed.journals, "je-3": mirrorLines },
    };
    const verdict = reconcile({ posted, reversed, replayed: doubled });
    expect(verdict.violations.join(" | ")).toMatch(/2 reversal events/);
  });

  it("proves a reversal that never reached the ledger", () => {
    const notReversed: LedgerSnapshot = posted;
    const verdict = reconcile({ posted, reversed: notReversed, replayed: notReversed });
    expect(verdict.violations.join(" | ")).toMatch(/no reversal event/);
  });

  it("cannot judge when the expense was never posted to the ledger", () => {
    const queued: LedgerSnapshot = { events: [], journals: {} };
    const verdict = reconcile({ posted: queued, reversed: queued, replayed: queued });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged[0]).toMatch(/never posted/);
  });

  it("cannot judge a journal that could not be read", () => {
    const missing: LedgerSnapshot = { events: reversed.events, journals: { "je-1": originalLines } };
    const verdict = reconcile({ posted, reversed: missing, replayed: missing });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged.join(" | ")).toMatch(/journal je-2 was not readable/);
  });
  describe("the ledger as the whole footprint of the expense", () => {
    const withEvents = (extra: LedgerSnapshot["events"], journals: LedgerSnapshot["journals"] = {}): LedgerSnapshot => ({
      events: [...reversed.events, ...extra],
      journals: { ...reversed.journals, ...journals },
    });

    it("proves an extra reversal whose link to the original is missing", () => {
      const stray = withEvents([{ ...reversalEvent, id: "ev-3", reversalOfEventId: null, journalEntryId: "je-3" }], {
        "je-3": mirrorLines,
      });
      const verdict = reconcile({ posted, reversed, replayed: stray });
      expect(verdict.violations.join(" | ")).toMatch(/2 reversal events/);
    });

    it("proves an extra reversal linked to a different event", () => {
      const stray = withEvents([{ ...reversalEvent, id: "ev-3", reversalOfEventId: "ev-other", journalEntryId: "je-3" }], {
        "je-3": mirrorLines,
      });
      const verdict = reconcile({ posted, reversed: stray, replayed: stray });
      expect(verdict.violations.join(" | ")).toMatch(/2 reversal events/);
    });

    it("proves a stray reversal when the canonical one is missing altogether", () => {
      const strayOnly: LedgerSnapshot = {
        events: [postedEvent, { ...reversalEvent, reversalOfEventId: null }],
        journals: { "je-1": originalLines, "je-2": mirrorLines },
      };
      const verdict = reconcile({ posted, reversed: strayOnly, replayed: strayOnly });
      expect(verdict.violations.join(" | ")).toMatch(/no reversal event|1 reversal event .* not linked/);
      expect(verdict.violations.length).toBeGreaterThan(0);
    });

    it("proves a second posting event for the same expense after the reversal", () => {
      const reposted = withEvents([{ ...postedEvent, id: "ev-4", journalEntryId: "je-4" }], { "je-4": originalLines });
      const verdict = reconcile({ posted, reversed: reposted, replayed: reposted });
      expect(verdict.violations.join(" | ")).toMatch(/2 posting events|posted again/);
    });
  });

  describe("the posting itself must be a real, balanced effect of the seeded amount", () => {
    const run = (
      lines: readonly (typeof originalLines)[number][],
      mirror: readonly (typeof originalLines)[number][],
      expectedCurrency: string | null = "JOD",
    ) => {
      const post: LedgerSnapshot = { events: [postedEvent], journals: { "je-1": lines } };
      const rev: LedgerSnapshot = {
        events: [{ ...postedEvent, status: "REVERSED", reversedByEventId: "ev-2" }, reversalEvent],
        journals: { "je-1": lines, "je-2": mirror },
      };
      return evaluateReversalReconciliation({ posted: post, reversed: rev, replayed: rev, seededAmount: 53, expectedCurrency });
    };
    const mirrorOf = (lines: typeof originalLines) =>
      lines.map((line) => ({ ...line, debitMinor: line.creditMinor, creditMinor: line.debitMinor }));

    it("proves an unbalanced posting even though its exact mirror reverses it", () => {
      const lines = [originalLines[0]!, { ...originalLines[1]!, creditMinor: 40_000 }];
      const verdict = run(lines, mirrorOf(lines));
      expect(verdict.violations.join(" | ")).toMatch(/not balanced/);
    });

    it("proves a zero posting", () => {
      const lines = originalLines.map((line) => ({ ...line, debitMinor: 0, creditMinor: 0 }));
      const verdict = run(lines, mirrorOf(lines));
      expect(verdict.violations.join(" | ")).toMatch(/zero/);
    });

    it("proves a balanced posting of the wrong amount", () => {
      const lines = [
        { ...originalLines[0]!, debitMinor: 5_300 },
        { ...originalLines[1]!, creditMinor: 5_300 },
      ];
      const verdict = run(lines, mirrorOf(lines));
      expect(verdict.violations.join(" | ")).toMatch(/5300 minor units .* 53000/);
    });

    it("proves a posting whose lines disagree on currency or scale", () => {
      const lines = [originalLines[0]!, { ...originalLines[1]!, currency: "USD" }];
      const verdict = run(lines, mirrorOf(lines));
      expect(verdict.violations.length).toBeGreaterThan(0);
    });

    it("proves a posting stored at a scale its currency does not use", () => {
      const lines = originalLines.map((line) => ({ ...line, scale: 2 }));
      const verdict = run(lines, mirrorOf(lines));
      expect(verdict.violations.join(" | ")).toMatch(/scale/);
    });

    it("cannot judge a posting with non-finite, fractional or negative amounts", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -53_000]) {
        const lines = [{ ...originalLines[0]!, debitMinor: bad }, originalLines[1]!];
        const verdict = run(lines, mirrorOf(lines));
        expect(verdict.violations).toEqual([]);
        expect(verdict.unjudged.join(" | ")).toMatch(/not a whole non-negative number/);
      }
    });

    it("proves a balanced posting in another currency than the organization's, even with its exact mirror", () => {
      // 53 USD at scale 2 is a perfectly consistent entry: only the organization's own currency convicts it.
      const lines = originalLines.map((line) => ({ ...line, debitMinor: line.debitMinor && 5_300, creditMinor: line.creditMinor && 5_300, scale: 2, currency: "USD" }));
      const verdict = run(lines, mirrorOf(lines), "JOD");
      expect(verdict.violations.join(" | ")).toMatch(/posted in USD but the organization's currency is JOD/);
    });

    it("judges the same 53 USD posting clean when USD is the organization's currency", () => {
      const lines = originalLines.map((line) => ({ ...line, debitMinor: line.debitMinor && 5_300, creditMinor: line.creditMinor && 5_300, scale: 2, currency: "USD" }));
      expect(run(lines, mirrorOf(lines), "USD")).toEqual({ violations: [], unjudged: [] });
    });

    it("cannot judge when the organization's currency could not be read independently", () => {
      const verdict = run(originalLines, mirrorOf(originalLines), null);
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged.join(" | ")).toMatch(/organization's currency was not readable/);
    });

    it("cannot judge when the organization's currency is not one the product supports", () => {
      const lines = originalLines.map((line) => ({ ...line, currency: "XXX" }));
      const verdict = run(lines, mirrorOf(lines), "XXX");
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged.join(" | ")).toMatch(/currency XXX is not one the product supports/);
    });

    it("cannot judge a posting whose lines are not two or more", () => {
      const verdict = run([originalLines[0]!], mirrorOf([originalLines[0]!]));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged.length).toBeGreaterThan(0);
    });
  });
});
