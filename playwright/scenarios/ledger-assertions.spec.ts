import { expect, test } from "@playwright/test";
import { type LedgerDelta, expectLedgerDelta, expectOnlyKnownDefect, jod } from "../ledger";

/**
 * The GL assertions the scenario matrix rests on, checked against hand-built
 * deltas (no browser, no backend). An assertion that cannot fail certifies
 * nothing, so each case here is one the helper must REFUSE (SCRUM-595, Codex
 * AF-430-02 / AF-430-05).
 */

type Side = { dr: number; cr: number };

function delta(...journals: Array<Record<string, Partial<Side>>>): LedgerDelta {
  const byCode: Record<string, Side> = {};
  const newEntries: LedgerDelta["newEntries"] = journals.map((j, i) => {
    const lines: Record<string, Side> = {};
    for (const [code, s] of Object.entries(j)) {
      lines[code] = { dr: s.dr ?? 0, cr: s.cr ?? 0 };
      // As ledgerDelta: an account that did not move is not in the delta.
      if (!s.dr && !s.cr) continue;
      const t = byCode[code] ?? { dr: 0, cr: 0 };
      t.dr += s.dr ?? 0;
      t.cr += s.cr ?? 0;
      byCode[code] = t;
    }
    const debit = Object.values(lines).reduce((n, s) => n + s.dr, 0);
    const credit = Object.values(lines).reduce((n, s) => n + s.cr, 0);
    return { id: `je${i}`, memo: `journal ${i}`, debit, credit, byCode: lines };
  });
  return { byCode, newEntries, unposted: [] };
}

// F01's close, as ruled: one journal.
const CLOSE = {
  "1210": { dr: jod(13_000) },
  "4100": { cr: jod(13_000) },
  "5100": { dr: jod(10_000) },
  "1400": { cr: jod(10_000) },
};

test.describe("GL assertion self-test", () => {
  test("accepts the ruled single journal", () => {
    expectLedgerDelta(delta(CLOSE), CLOSE);
  });

  test("refuses the right account totals split across the wrong journals", () => {
    // Codex AF-430-05: both entries balance and the totals per account match.
    const misallocated = delta(
      { "1210": { dr: jod(13_000) }, "4100": { cr: jod(3_000) }, "1400": { cr: jod(10_000) } },
      { "5100": { dr: jod(10_000) }, "4100": { cr: jod(10_000) } },
    );
    expect(() => expectLedgerDelta(misallocated, CLOSE)).toThrow();
  });

  test("refuses one extra balanced journal on top of the ruled one", () => {
    const extra = delta(CLOSE, { "1110": { dr: jod(1) }, "1100": { cr: jod(1) } });
    expect(() => expectLedgerDelta(extra, CLOSE)).toThrow();
  });

  test("refuses any movement where none is ruled", () => {
    expect(() => expectLedgerDelta(delta(), {})).not.toThrow();
    expect(() => expectLedgerDelta(delta({ "1110": { dr: 5 }, "1100": { cr: 5 } }), {})).toThrow();
    // A new journal is a posting even when every line is zero.
    expect(() => expectLedgerDelta(delta({ "1110": { dr: 0, cr: 0 } }), {})).toThrow();
  });

  test("accepts several journals when the step names them all", () => {
    const a = { "1100": { dr: jod(400) }, "2100": { cr: jod(400) } };
    const b = { "2100": { dr: jod(400) }, "1100": { cr: jod(400) } };
    expectLedgerDelta(delta(b, a), [a, b]);
  });

  test.describe("a step relaxed for a known defect", () => {
    const RULED = { "1100": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } };
    const DEFECT = {
      key: "SCRUM-599",
      posts: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    };

    test("passes only on the recorded wrong posting", () => {
      expectOnlyKnownDefect(delta(DEFECT.posts), RULED, DEFECT);
    });

    test("fails once the step posts as ruled (the defect is fixed)", () => {
      expect(() => expectOnlyKnownDefect(delta(RULED), RULED, DEFECT)).toThrow(/looks fixed/);
    });

    test("fails on any other wrong posting", () => {
      const other = delta({ "1300": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } });
      expect(() => expectOnlyKnownDefect(other, RULED, DEFECT)).toThrow();
    });
  });
});
