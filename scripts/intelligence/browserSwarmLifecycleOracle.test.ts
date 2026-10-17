import { describe, expect, it } from "vitest";
import type { LedgerEvent, LedgerLine, LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import {
  evaluateDepositVoidTransition,
  type DepositLifecycleState,
  type DepositVoidTransitionInput,
  type DepositView,
} from "./browserSwarmLifecycleOracle";

/**
 * SCRUM-350 LIFE-1 — the pure judgement of a deposit void with a survivor.
 * Every figure is written out by hand in JOD minor units (scale 3): 200 → 200,000
 * and 300 → 300,000. Each case flips exactly one fact of an otherwise correct
 * sequence, so a verdict changes only when the judgement it pins is removed.
 */

const line = (accountId: string, debitMinor: number, creditMinor: number): LedgerLine => ({
  accountId,
  debitMinor,
  creditMinor,
  scale: 3,
  currency: "JOD",
});
const receiptLines = (minor: number): LedgerLine[] => [line("cash", minor, 0), line("liability", 0, minor)];
const mirrorLines = (minor: number): LedgerLine[] => [line("cash", 0, minor), line("liability", minor, 0)];

const event = (over: Partial<LedgerEvent> & { id: string }): LedgerEvent => ({
  eventType: "DEPOSIT_RECEIVED",
  status: "POSTED",
  reversalOfEventId: null,
  reversedByEventId: null,
  journalEntryId: `j-${over.id}`,
  ...over,
});

const held = (id: string, amountMinor: number): DepositView => ({
  id,
  status: "HELD",
  isDeleted: false,
  holdActive: true,
  amountMinor,
  releasedAmountMinor: 0,
  payment: { id: `pay-${id}`, status: "SETTLED", amountMinor, unappliedMinor: amountMinor },
});

const posted = (id: string, minor: number): LedgerSnapshot => ({
  events: [event({ id })],
  journals: { [`j-${id}`]: receiptLines(minor) },
});

const reversed = (id: string, minor: number): LedgerSnapshot => ({
  events: [
    event({ id, status: "REVERSED", reversedByEventId: "rev" }),
    event({ id: "rev", eventType: "JOURNAL_REVERSAL", reversalOfEventId: id }),
  ],
  journals: { [`j-${id}`]: receiptLines(minor), "j-rev": mirrorLines(minor) },
});

const BEFORE: DepositLifecycleState = {
  voided: held("dA", 200_000),
  survivor: held("dB", 300_000),
  voidedLedger: posted("eA", 200_000),
  survivorLedger: posted("eB", 300_000),
  vehicleStatus: "RESERVED",
};
const AFTER_VOID: DepositLifecycleState = {
  ...BEFORE,
  voided: {
    ...held("dA", 200_000),
    status: "VOIDED",
    isDeleted: true,
    holdActive: false,
    payment: { id: "pay-dA", status: "VOIDED", amountMinor: 200_000, unappliedMinor: 0 },
  },
  voidedLedger: reversed("eA", 200_000),
};

const input = (over: Partial<DepositVoidTransitionInput> = {}): DepositVoidTransitionInput => ({
  before: BEFORE,
  afterVoid: AFTER_VOID,
  afterAttempts: AFTER_VOID,
  voidedAmountMajor: 200,
  survivorAmountMajor: 300,
  expectedCurrency: "JOD",
  ...over,
});

describe("SCRUM-350 LIFE-1 evaluateDepositVoidTransition", () => {
  it("is clean for a void that unwinds only the voided deposit", () => {
    expect(evaluateDepositVoidTransition(input())).toEqual({ violations: [], unjudged: [] });
  });

  it("flags a void that reverses the surviving deposit's receipt too", () => {
    const verdict = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, survivorLedger: reversed("eB", 300_000) } }),
    );
    expect(verdict.violations).toContain(
      "the void changed the surviving deposit's ledger postings (its receipt was reversed or rewritten)",
    );
  });

  it("flags a void that frees the car while the survivor still holds it", () => {
    const verdict = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, vehicleStatus: "AVAILABLE" } }));
    expect(verdict.violations).toEqual([
      "the void released the car (AVAILABLE) while the surviving deposit still holds it",
      "a repeated void, refund or forfeit of the voided deposit changed deposit, ledger or car state",
    ]);
  });

  it("flags a surviving deposit whose row was altered by the void", () => {
    const verdict = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, survivor: { ...held("dB", 300_000), holdActive: false } } }),
    );
    expect(verdict.violations.some((entry) => entry.startsWith("the void changed the surviving deposit from"))).toBe(true);
  });

  it("flags a voided deposit that is not VOIDED, or that still holds its car", () => {
    const stillHeld = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, voided: held("dA", 200_000) } }));
    expect(stillHeld.violations).toContain("after the void, the voided deposit is HELD, not VOIDED");
    const holding = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voided: { ...held("dA", 200_000), status: "VOIDED", holdActive: true } } }),
    );
    expect(holding.violations).toContain("after the void, the voided deposit still holds its car");
  });

  it("flags a missing, duplicated, unlinked, unposted or non-mirroring reversal", () => {
    const none = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, voidedLedger: posted("eA", 200_000) } }));
    expect(none.violations).toContain("after void: the voided deposit's receipt has no reversal event");

    const base = reversed("eA", 200_000);
    const twice = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voidedLedger: { ...base, events: [...base.events, event({ id: "rev2", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "eA" })] } } }),
    );
    expect(twice.violations).toContain("after void: the voided deposit's receipt has 2 reversal events");

    const unlinked = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voidedLedger: { ...base, events: [base.events[0]!, { ...base.events[1]!, reversalOfEventId: "other" }] } } }),
    );
    expect(unlinked.violations).toContain("after void: a reversal event is not linked to the voided deposit's receipt");

    const pending = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voidedLedger: { ...base, events: [base.events[0]!, { ...base.events[1]!, status: "PENDING" }] } } }),
    );
    expect(pending.violations).toContain("after void: the reversal event is PENDING, not POSTED");

    const skewed = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voidedLedger: { ...base, journals: { ...base.journals, "j-rev": mirrorLines(199_999) } } } }),
    );
    expect(skewed.violations).toContain("after void: the reversal journal does not mirror the receipt");
  });

  it("flags any extra event beside the receipt and its one linked reversal, after the void and after the repeats", () => {
    const base = reversed("eA", 200_000);
    for (const eventType of ["DEPOSIT_REFUNDED", "DEPOSIT_FORFEITED"]) {
      const withExtra: LedgerSnapshot = { ...base, events: [...base.events, event({ id: "x", eventType })] };
      const afterVoid = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, voidedLedger: withExtra } }));
      expect(afterVoid.violations, eventType).toContain(
        `after void: the voided deposit's ledger also holds 1 unexpected event (${eventType}); only the receipt and its one linked reversal may exist`,
      );
      const afterRepeat = evaluateDepositVoidTransition(input({ afterAttempts: { ...AFTER_VOID, voidedLedger: withExtra } }));
      expect(afterRepeat.violations.some((entry) => entry.startsWith("after repeated attempts:") && entry.includes(eventType)), eventType).toBe(true);
    }
  });

  it("flags a canonical payment that is not voided, is the wrong amount, or whose surviving twin changed", () => {
    const notVoided = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voided: { ...AFTER_VOID.voided!, payment: held("dA", 200_000).payment } } }),
    );
    expect(notVoided.violations).toContain("after the void, the voided deposit's canonical payment is SETTLED, not VOIDED");
    const short = evaluateDepositVoidTransition(
      input({ before: { ...BEFORE, survivor: { ...held("dB", 300_000), payment: { id: "p", status: "SETTLED", amountMinor: 299_999, unappliedMinor: 299_999 } } } }),
    );
    expect(short.violations).toContain("the surviving deposit's canonical payment holds 299999 minor units but 300000 were deposited");
    const killed = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, survivor: { ...held("dB", 300_000), payment: { id: "pay-dB", status: "VOIDED", amountMinor: 300_000, unappliedMinor: 0 } } } }),
    );
    expect(killed.violations.some((entry) => entry.startsWith("the void changed the surviving deposit from"))).toBe(true);
  });

  it("is unjudged, never a breach or a pass, when a payment or the car cannot be read", () => {
    const noPayment = evaluateDepositVoidTransition(input({ before: { ...BEFORE, voided: { ...held("dA", 200_000), payment: null } } }));
    expect(noPayment.violations).toEqual([]);
    expect(noPayment.unjudged).toContain("the voided deposit's canonical payment could not be read before the void");

    const lostAfter = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, survivor: { ...held("dB", 300_000), payment: null } } }),
    );
    expect(lostAfter.violations).toEqual([]);
    expect(lostAfter.unjudged).toContain("the surviving deposit's canonical payment could not be read after the void");

    const carUnread = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, vehicleStatus: null }, afterAttempts: { ...AFTER_VOID, vehicleStatus: null } }),
    );
    expect(carUnread.violations).toEqual([]);
    expect(carUnread.unjudged).toContain("the car's status could not be read after the void, so its release could not be judged");
  });

  it("flags a surviving deposit that disappears during the void itself", () => {
    const verdict = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, survivor: null } }));
    expect(verdict.violations).toContain("the surviving deposit disappeared after the void");
  });

  it("never passes when a deposit or the car's status is missing only after the repeated attempts", () => {
    const voidedGone = evaluateDepositVoidTransition(input({ afterAttempts: { ...AFTER_VOID, voided: null } }));
    expect(voidedGone.violations).toContain("the voided deposit disappeared after the repeated attempts");

    const survivorGone = evaluateDepositVoidTransition(input({ afterAttempts: { ...AFTER_VOID, survivor: null } }));
    expect(survivorGone.violations).toContain("the surviving deposit disappeared after the repeated attempts");

    const carGone = evaluateDepositVoidTransition(input({ afterAttempts: { ...AFTER_VOID, vehicleStatus: null } }));
    expect(carGone.violations).toEqual([]);
    expect(carGone.unjudged).toContain("the car's status could not be compared after the repeated attempts, so its release could not be judged");

    for (const verdict of [voidedGone, survivorGone, carGone]) {
      expect(verdict.violations.length + verdict.unjudged.length).toBeGreaterThan(0);
    }
  });

  it("flags a receipt rewritten in place", () => {
    const base = reversed("eA", 200_000);
    const verdict = evaluateDepositVoidTransition(
      input({ afterVoid: { ...AFTER_VOID, voidedLedger: { ...base, journals: { ...base.journals, "j-eA": receiptLines(200_001) } } } }),
    );
    expect(verdict.violations).toContain("after void: the receipt journal was rewritten instead of reversed");
  });

  it("flags any change after the repeated void, refund and forfeit, and a payout from the voided deposit", () => {
    const moved = evaluateDepositVoidTransition(
      input({ afterAttempts: { ...AFTER_VOID, voided: { ...AFTER_VOID.voided!, releasedAmountMinor: 200_000 } } }),
    );
    expect(moved.violations).toEqual([
      "a repeated void, refund or forfeit of the voided deposit changed deposit, ledger or car state",
      "the voided deposit paid out money after the void",
    ]);
    const extra = reversed("eA", 200_000);
    const again = evaluateDepositVoidTransition(
      input({ afterAttempts: { ...AFTER_VOID, voidedLedger: { ...extra, events: [...extra.events, event({ id: "rev2", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "eA" })] } } }),
    );
    expect(again.violations).toContain("a repeated void, refund or forfeit of the voided deposit changed deposit, ledger or car state");
  });

  it("flags a receipt that is unbalanced, in the wrong currency, at the wrong scale or for the wrong amount", () => {
    const skew = (lines: LedgerLine[]): DepositVoidTransitionInput =>
      input({
        before: { ...BEFORE, voidedLedger: { ...BEFORE.voidedLedger, journals: { "j-eA": lines } } },
        afterVoid: { ...AFTER_VOID, voidedLedger: reversed("eA", 200_000) },
      });
    expect(evaluateDepositVoidTransition(skew([line("cash", 200_000, 0), line("liability", 0, 199_000)])).violations[0]).toMatch(/not balanced/);
    expect(
      evaluateDepositVoidTransition(skew(receiptLines(200_000).map((entry) => ({ ...entry, currency: "USD" })))).violations[0],
    ).toMatch(/posted in USD but the organization's currency is JOD/);
    expect(
      evaluateDepositVoidTransition(skew(receiptLines(200_000).map((entry) => ({ ...entry, scale: 2 })))).violations[0],
    ).toMatch(/stored at scale 2 but JOD uses scale 3/);
    expect(evaluateDepositVoidTransition(skew(receiptLines(300_000))).violations[0]).toMatch(/moves 300000 minor units but 200000 were deposited/);
  });

  it("never passes a scenario that did not put a surviving obligation beside the voided one", () => {
    const cases: [string, DepositLifecycleState][] = [
      ["survivor unreadable", { ...BEFORE, survivor: null }],
      ["survivor not held", { ...BEFORE, survivor: { ...held("dB", 300_000), status: "VOIDED" } }],
      ["car not reserved", { ...BEFORE, vehicleStatus: "AVAILABLE" }],
      ["car unreadable", { ...BEFORE, vehicleStatus: null }],
      ["voided receipt missing", { ...BEFORE, voidedLedger: { events: [], journals: {} } }],
      ["survivor receipt pending", { ...BEFORE, survivorLedger: { ...posted("eB", 300_000), events: [event({ id: "eB", status: "PENDING" })] } }],
    ];
    for (const [name, before] of cases) {
      const verdict = evaluateDepositVoidTransition(input({ before }));
      expect(verdict.violations, name).toEqual([]);
      expect(verdict.unjudged.length, name).toBeGreaterThan(0);
    }
  });

  it("is unjudged, never clean, when the currency, a journal or a read-back is missing", () => {
    expect(evaluateDepositVoidTransition(input({ expectedCurrency: null })).unjudged).toHaveLength(2);
    expect(evaluateDepositVoidTransition(input({ expectedCurrency: "XXX" })).unjudged.length).toBeGreaterThan(0);
    const noJournal = evaluateDepositVoidTransition(
      input({ before: { ...BEFORE, voidedLedger: { ...BEFORE.voidedLedger, journals: {} } } }),
    );
    expect(noJournal).toEqual({ violations: [], unjudged: ["a receipt journal was not readable before the void"] });
    const lostVoided = evaluateDepositVoidTransition(input({ afterVoid: { ...AFTER_VOID, voided: null }, afterAttempts: { ...AFTER_VOID, voided: null } }));
    expect(lostVoided.unjudged).toContain("the voided deposit could not be read back after the void");
  });
});
