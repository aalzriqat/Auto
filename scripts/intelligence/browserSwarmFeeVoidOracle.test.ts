import { describe, expect, it } from "vitest";
import type { LedgerEvent, LedgerLine, LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import { evaluateDirectFeeVoid, feeVoidAmounts, type FeeLineView, type FeeVoidObservation } from "./browserSwarmFeeVoidOracle";

/**
 * SCRUM-350 LIFE-1 — the pure judgement of voiding a directly paid cost.
 *
 * Every figure is written out by hand: a 50 cost is voided, a 20 cost stays, in JOD (scale 3), so
 * the payment is 50,000 minor units debiting the ownership-transfer expense and crediting the bank.
 * Each test flips exactly one fact of the ledger or of the deal's cost lines.
 */
const KEY_OF = new Map([
  ["acct-expense", "OWNERSHIP_TRANSFER_EXPENSE"],
  ["acct-bank", "BANK_ACCOUNT"],
  ["acct-cash", "CASH_ON_HAND"],
]);

const line = (accountId: string, debitMinor: number, creditMinor: number): LedgerLine => ({
  accountId,
  debitMinor,
  creditMinor,
  scale: 3,
  currency: "JOD",
});

const paymentLines = (amount: number): LedgerLine[] => [line("acct-expense", amount, 0), line("acct-bank", 0, amount)];
const mirrorLines = (amount: number): LedgerLine[] => [line("acct-expense", 0, amount), line("acct-bank", amount, 0)];

const payment = (fee: string, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: `pay-${fee}`,
  eventType: "HANDOVER_COST_PAID_DIRECT",
  status: "POSTED",
  reversalOfEventId: null,
  reversedByEventId: null,
  journalEntryId: `je-pay-${fee}`,
  ...over,
});

const reversal = (fee: string, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: `rev-${fee}`,
  eventType: "JOURNAL_REVERSAL",
  status: "POSTED",
  reversalOfEventId: `pay-${fee}`,
  reversedByEventId: null,
  journalEntryId: `je-rev-${fee}`,
  ...over,
});

const paid = (fee: string, amount: number): LedgerSnapshot => ({
  events: [payment(fee)],
  journals: { [`je-pay-${fee}`]: paymentLines(amount) },
});

const taken = (fee: string, amount: number): LedgerSnapshot => ({
  events: [payment(fee, { status: "REVERSED", reversedByEventId: `rev-${fee}` }), reversal(fee)],
  journals: { [`je-pay-${fee}`]: paymentLines(amount), [`je-rev-${fee}`]: mirrorLines(amount) },
});

const view = (id: string, amount: number): FeeLineView => ({
  id,
  actualAmountMinor: amount,
  paymentVersion: 1,
  paymentAmountMinor: amount,
});

function observation(over: Partial<FeeVoidObservation> = {}): FeeVoidObservation {
  const voidedTaken = taken("a", 50_000);
  const survivor = paid("b", 20_000);
  const survivorLine = view("b", 20_000);
  return {
    currency: "JOD",
    figures: { voidedMajor: 50, survivingMajor: 20 },
    voidedFeeId: "a",
    survivingFeeId: "b",
    keyOf: KEY_OF,
    voided: { paid: paid("a", 50_000), afterVoid: voidedTaken, afterRepeat: voidedTaken },
    surviving: { paid: survivor, afterVoid: survivor, afterRepeat: survivor },
    lines: {
      beforeVoid: [view("a", 50_000), survivorLine],
      afterVoid: [survivorLine],
      afterRepeat: [survivorLine],
    },
    repeatAccepted: true,
    ...over,
  };
}

const verdict = (over: Partial<FeeVoidObservation> = {}) => evaluateDirectFeeVoid(observation(over));

describe("SCRUM-350 LIFE-1 fee void oracle: the hand-worked scenario", () => {
  it("judges a correct void clean: one linked mirror reversal, the line gone, the sibling and a retry untouched", () => {
    expect(verdict()).toEqual({ violations: [], unjudged: [] });
  });

  it("accepts a reversal whose lines are listed in another order", () => {
    const base = observation();
    const reordered = {
      ...base.voided.afterVoid,
      journals: { ...base.voided.afterVoid.journals, "je-rev-a": [...mirrorLines(50_000)].reverse() },
    };
    expect(verdict({ voided: { ...base.voided, afterVoid: reordered, afterRepeat: reordered } })).toEqual({ violations: [], unjudged: [] });
  });
});

describe("SCRUM-350 LIFE-1 fee void oracle: the transition", () => {
  const withVoided = (afterVoid: LedgerSnapshot, afterRepeat: LedgerSnapshot = afterVoid) => {
    const base = observation();
    return verdict({ voided: { ...base.voided, afterVoid, afterRepeat } });
  };

  it("FAILS a void that leaves the payment on the books (no reversal)", () => {
    const result = withVoided(paid("a", 50_000));
    expect(result.violations).toContain("the voided cost: the ledger holds 0 reversal events for one direct payment, expected exactly one");
  });

  it("FAILS a reversal that is not linked to the payment it takes back", () => {
    const base = taken("a", 50_000);
    const result = withVoided({ ...base, events: [base.events[0]!, reversal("a", { reversalOfEventId: null })] });
    expect(result.violations).toContain("the voided cost: the reversal is not linked to the direct payment it takes back");
  });

  it("FAILS an original left POSTED, not linked forward to its reversal", () => {
    const base = taken("a", 50_000);
    const result = withVoided({ ...base, events: [payment("a"), base.events[1]!] });
    expect(result.violations).toContain("the voided cost: the original direct payment is not linked to its reversal");
  });

  it("FAILS a reversal that is not the mirror of the payment, by one minor unit and by side", () => {
    const base = taken("a", 50_000);
    const off = withVoided({ ...base, journals: { ...base.journals, "je-rev-a": mirrorLines(49_999) } });
    expect(off.violations).toContain("the voided cost: the reversal journal does not mirror the posted journal");
    const sameSide = withVoided({ ...base, journals: { ...base.journals, "je-rev-a": paymentLines(50_000) } });
    expect(sameSide.violations).toContain("the voided cost: the reversal journal does not mirror the posted journal");
  });

  it("FAILS a reversal event that is not POSTED", () => {
    const base = taken("a", 50_000);
    const result = withVoided({ ...base, events: [base.events[0]!, reversal("a", { status: "PENDING" })] });
    expect(result.violations).toContain("the voided cost: the reversal event is PENDING, not POSTED");
  });

  it("FAILS two reversals for one payment", () => {
    const base = taken("a", 50_000);
    const result = withVoided({ ...base, events: [...base.events, reversal("a", { id: "rev-a-2", journalEntryId: "je-rev-a-2" })] });
    expect(result.violations).toContain("the voided cost: the ledger holds 2 reversal events for one direct payment, expected exactly one");
  });

  it("FAILS a payment re-posted by the void", () => {
    const base = taken("a", 50_000);
    const result = withVoided({
      ...base,
      events: [...base.events, payment("a", { id: "pay-a-2", journalEntryId: "je-pay-a-2" })],
      journals: { ...base.journals, "je-pay-a-2": paymentLines(50_000) },
    });
    expect(result.violations).toContain("the voided cost: the void left 2 direct payment events, expected the original alone (no re-post)");
  });

  it("FAILS posted history rewritten instead of reversed, and an original that vanished", () => {
    const base = taken("a", 50_000);
    const rewritten = withVoided({ ...base, journals: { ...base.journals, "je-pay-a": paymentLines(50_001) } });
    expect(rewritten.violations).toContain("the voided cost: the posted journal lines were rewritten instead of reversed");
    const gone = withVoided({ events: [reversal("a")], journals: { "je-rev-a": mirrorLines(50_000) } });
    expect(gone.violations).toContain("the voided cost: the original direct payment pay-a is gone from the ledger");
  });

  it("FAILS a voided line that is still live on the deal", () => {
    const base = observation();
    const result = verdict({ lines: { ...base.lines, afterVoid: [view("a", 50_000), view("b", 20_000)], afterRepeat: [view("a", 50_000), view("b", 20_000)] } });
    expect(result.violations).toContain("the voided cost is still a live line on the deal after the void");
  });
});

describe("SCRUM-350 LIFE-1 fee void oracle: unrelated obligations and a retry", () => {
  it("FAILS a void that also reverses the other directly paid cost", () => {
    const base = observation();
    const result = verdict({ surviving: { ...base.surviving, afterVoid: taken("b", 20_000), afterRepeat: taken("b", 20_000) } });
    expect(result.violations.join(" ")).toMatch(/the surviving cost's ledger across the void changed/);
  });

  it("FAILS a surviving cost that loses its direct payment or its line", () => {
    const base = observation();
    const lost = { ...view("b", 20_000), paymentVersion: null, paymentAmountMinor: null };
    const stripped = verdict({ lines: { ...base.lines, afterVoid: [lost], afterRepeat: [lost] } });
    expect(stripped.violations).toContain("the surviving cost lost its recorded amount, its direct payment or its line when the other cost was voided");
    const dropped = verdict({ lines: { ...base.lines, afterVoid: [], afterRepeat: [] } });
    expect(dropped.violations).toContain("the surviving cost lost its recorded amount, its direct payment or its line when the other cost was voided");
  });

  it("judges the recorded amount from the public line: a survivor whose amount changed is a breach, a premise line with the wrong amount unjudged", () => {
    const base = observation();
    const changed = { ...view("b", 20_000), actualAmountMinor: 25_000 };
    const survivor = verdict({ lines: { ...base.lines, afterVoid: [changed], afterRepeat: [changed] } });
    expect(survivor.violations).toContain("the surviving cost lost its recorded amount, its direct payment or its line when the other cost was voided");
    const unrecorded = { ...view("a", 50_000), actualAmountMinor: null };
    const premise = verdict({ lines: { ...base.lines, beforeVoid: [unrecorded, view("b", 20_000)] } });
    expect(premise.violations).toEqual([]);
    expect(premise.unjudged).toEqual([
      "the deal's cost lines did not show both costs as recorded and directly paid at the scenario's amounts before the void",
    ]);
  });

  it("names an unreadable original journal once, after the void, and still judges the reversal's mirror against the paid journal", () => {
    const base = observation();
    const voidedTaken = taken("a", 50_000);
    const { ["je-pay-a"]: _gone, ...journals } = voidedTaken.journals;
    void _gone;
    const unreadable = { ...voidedTaken, journals };
    const result = verdict({ voided: { ...base.voided, afterVoid: unreadable, afterRepeat: unreadable } });
    expect(result.violations).toEqual([]);
    expect(result.unjudged).toEqual(["the voided cost: the original journal was not readable after the void"]);
  });

  it("FAILS a repeated void that reverses again, or moves the sibling, or changes the deal", () => {
    const base = observation();
    const twice = taken("a", 50_000);
    const again = verdict({
      voided: {
        ...base.voided,
        afterRepeat: { ...twice, events: [...twice.events, reversal("a", { id: "rev-a-2", journalEntryId: "je-rev-a-2" })] },
      },
    });
    expect(again.violations.join(" ")).toMatch(/the voided cost's ledger across the repeated void changed/);
    const sibling = verdict({ surviving: { ...base.surviving, afterRepeat: taken("b", 20_000) } });
    expect(sibling.violations.join(" ")).toMatch(/the surviving cost's ledger across the repeated void changed/);
    const deal = verdict({ lines: { ...base.lines, afterRepeat: [] } });
    expect(deal.violations.join(" ")).toMatch(/the deal's live cost lines across the repeated void changed/);
  });

  it("leaves a refused retry unjudged, never a pass", () => {
    const result = verdict({ repeatAccepted: false });
    expect(result.violations).toEqual([]);
    expect(result.unjudged).toEqual(["the product refused the repeated void, so its answer to a retry is not the idempotent one the contract describes"]);
  });
});

describe("SCRUM-350 LIFE-1 fee void oracle: the figures helper both callers share", () => {
  it("returns both amounts in minor units, or one reason for any figures that cannot tell the costs apart", () => {
    expect(feeVoidAmounts({ voidedMajor: 50, survivingMajor: 20 }, "JOD")).toEqual({ ok: true, voidedMinor: 50_000, survivingMinor: 20_000 });
    for (const [figures, currency] of [
      [{ voidedMajor: 20, survivingMajor: 20 }, "JOD"],
      [{ voidedMajor: 0, survivingMajor: 20 }, "JOD"],
      [{ voidedMajor: 50.0005, survivingMajor: 20 }, "JOD"],
      [{ voidedMajor: 50, survivingMajor: 20 }, "XXX"],
    ] as const) {
      const result = feeVoidAmounts(figures, currency);
      expect(result).toEqual({
        ok: false,
        reason: `the figures ${figures.voidedMajor} and ${figures.survivingMajor} are not two distinct whole positive amounts in ${currency}`,
      });
    }
  });
});

describe("SCRUM-350 LIFE-1 fee void oracle: never a vacuous pass", () => {
  it("is unjudged without a currency, and for figures that cannot tell the two costs apart", () => {
    expect(verdict({ currency: null }).unjudged).toHaveLength(1);
    expect(verdict({ figures: { voidedMajor: 20, survivingMajor: 20 } }).unjudged[0]).toMatch(/not two distinct whole positive amounts in JOD/);
    expect(verdict({ figures: { voidedMajor: 50.0005, survivingMajor: 20 } }).unjudged).toHaveLength(1);
    expect(verdict({ currency: "XXX" }).unjudged).toHaveLength(1);
  });

  it("is unjudged when a payment never reached the ledger or posted twice, and does not read the void", () => {
    const base = observation();
    const never = verdict({ voided: { ...base.voided, paid: { events: [], journals: {} } } });
    expect(never.violations).toEqual([]);
    expect(never.unjudged).toEqual(["the voided cost: the direct payment never reached the ledger, so there was no posted payment to take back"]);
    const pending = verdict({ voided: { ...base.voided, paid: { ...base.voided.paid, events: [payment("a", { status: "PENDING" })] } } });
    expect(pending.unjudged).toEqual(["the voided cost: the direct payment had no posted, readable journal before the void"]);
    const doubled = verdict({
      surviving: { ...base.surviving, paid: { ...base.surviving.paid, events: [payment("b"), payment("b", { id: "pay-b-2" })] } },
    });
    expect(doubled.unjudged).toEqual(["the surviving cost: the line produced 2 direct payment events before any void"]);
  });

  it("is unjudged when the deal's lines did not show both costs paid, or an account is unnamed by the chart", () => {
    const base = observation();
    const unpaid = { ...view("b", 20_000), paymentVersion: null, paymentAmountMinor: null };
    expect(verdict({ lines: { ...base.lines, beforeVoid: [view("a", 50_000), unpaid] } }).unjudged).toEqual([
      "the deal's cost lines did not show both costs as recorded and directly paid at the scenario's amounts before the void",
    ]);
    expect(verdict({ keyOf: new Map([["acct-bank", "BANK_ACCOUNT"]]) }).unjudged).toEqual([
      "the voided cost: the direct payment posted to an account the chart cannot name",
      "the surviving cost: the direct payment posted to an account the chart cannot name",
    ]);
  });

  it("FAILS a payment posted on the wrong accounts, at the wrong amount, or in the wrong scale, before judging the void", () => {
    const base = observation();
    const wrongAccounts = {
      events: [payment("a")],
      journals: { "je-pay-a": [line("acct-expense", 50_000, 0), line("acct-cash", 0, 50_000)] },
    };
    const accounts = verdict({ voided: { ...base.voided, paid: wrongAccounts } });
    expect(accounts.violations.join(" ")).toMatch(/the direct payment moved \[CASH_ON_HAND\|0\|50000, OWNERSHIP_TRANSFER_EXPENSE\|50000\|0\] but a 50000 bank-transfer payment debits/);
    const wrongAmount = { events: [payment("a")], journals: { "je-pay-a": paymentLines(49_999) } };
    expect(verdict({ voided: { ...base.voided, paid: wrongAmount } }).violations.join(" ")).toMatch(/the direct payment moved/);
    const wrongScale = {
      events: [payment("a")],
      journals: { "je-pay-a": paymentLines(50_000).map((entry) => ({ ...entry, scale: 2 })) },
    };
    expect(verdict({ voided: { ...base.voided, paid: wrongScale } }).violations).toContain(
      "the voided cost: the direct payment is not posted in JOD at that currency's scale",
    );
  });
});
