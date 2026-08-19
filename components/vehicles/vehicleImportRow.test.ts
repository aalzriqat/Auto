import { describe, expect, test } from "vitest";

import { PURCHASE_IMPORT_MAX_ROWS } from "@/convex/utils/importLimits";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { describeImportResult } from "@/components/import/ImportWizard";
import {
  IMPORT_PURCHASE_MAX_ROWS,
  deriveVehicleRow,
  parseMoneyCell,
  purchaseBlockers,
  validateVehicleRow,
} from "./VehicleImportDialog";

/**
 * The import dialog's two pure gating functions.
 *
 * They had no tests at all, and that is how a supplier column could be silently
 * discarded for exactly the rows that need it while every server-side test still
 * passed: the backend suite constructs `sourcedFromName` directly and therefore
 * never exercises the projection that drops it.
 */

const stockRow = {
  make: "Kia",
  model: "Sportage",
  year: "2023",
  vin: "IMPORTSUP0000001A",
  color: "Silver",
  sellingPrice: "15000",
  purchasePrice: "10000",
  sourcedFrom: "Atiwi Motors",
};

describe("deriveVehicleRow — the supplier a purchase on account is owed to", () => {
  test("keeps the supplier on an OWNED row, which is the only kind that capitalizes", () => {
    const row = deriveVehicleRow(stockRow);

    // Not SOURCED: owned stock is what a PURCHASE import capitalizes.
    expect(row.sourceType).not.toBe("SOURCED");
    // The defect: this was `undefined` for every non-SOURCED row, so an
    // ON_ACCOUNT import could never name who it owed and was blocked forever —
    // even from a spreadsheet that gave the supplier on every line.
    expect(row.sourcedFromName).toBe("Atiwi Motors");
  });

  test("still leaves it undefined when the sheet names no supplier", () => {
    const { sourcedFrom: _omitted, ...noSupplier } = stockRow;
    expect(deriveVehicleRow(noSupplier).sourcedFromName).toBeUndefined();
  });

  test("does not put a supplier cost on an owned row", () => {
    // sourceCost stays SOURCED-only; only the NAME needed to cross over.
    expect(deriveVehicleRow(stockRow).sourceCost).toBeUndefined();
  });
});

describe("purchaseBlockers — the preflight must agree with the server", () => {
  test("ON_ACCOUNT is satisfiable once the supplier survives the projection", () => {
    const derived = deriveVehicleRow(stockRow);
    expect(purchaseBlockers([derived], "ON_ACCOUNT").missingSupplier).toBe(0);
  });

  test("and still refuses a capitalizing row with no supplier", () => {
    const { sourcedFrom: _omitted, ...noSupplier } = stockRow;
    const derived = deriveVehicleRow(noSupplier);
    expect(purchaseBlockers([derived], "ON_ACCOUNT").missingSupplier).toBe(1);
  });

  test("a settled method never asks for a supplier", () => {
    const { sourcedFrom: _omitted, ...noSupplier } = stockRow;
    const derived = deriveVehicleRow(noSupplier);
    expect(purchaseBlockers([derived], "CASH").missingSupplier).toBe(0);
  });

  test("a cost-less row is not capitalizing, so it needs no supplier either", () => {
    const { purchasePrice: _omitted, sourcedFrom: _alsoOmitted, ...noCost } = stockRow;
    const derived = deriveVehicleRow(noCost);
    expect(purchaseBlockers([derived], "ON_ACCOUNT").missingSupplier).toBe(0);
  });

  test("missingVin uses the same placeholder rule as the server, not a restatement", () => {
    // `N/A` is non-empty, so the old `!vin.trim()` restatement counted it as
    // present while the server refused it. The two only agreed because
    // deriveVehicleRow happens to normalize placeholders to "" first — an
    // implicit dependency that would have broken silently.
    expect(purchaseBlockers([{ vin: "N/A" }], "CASH").missingVin).toBe(1);
    expect(purchaseBlockers([{ vin: "xxxxxxxxxxxxxxxxx" }], "CASH").missingVin).toBe(1);
    expect(purchaseBlockers([{ vin: "" }], "CASH").missingVin).toBe(1);
    expect(purchaseBlockers([{ vin: "IMPORTSUP0000001A" }], "CASH").missingVin).toBe(0);
  });

  test("malformed VINs are counted by the shared server predicate", () => {
    expect(purchaseBlockers([{ vin: "1HGCM826-33A0043" }], "CASH").malformedVin).toBe(1);
    expect(purchaseBlockers([{ vin: "1HGCM82633A0043" }], "CASH").malformedVin).toBe(0);
  });
});

describe("purchaseBlockers — a PURCHASE import is ONE transaction over the WHOLE file", () => {
  const row = () => deriveVehicleRow(stockRow);
  const file = (total: number, invalid = 0) => ({ invalidCount: invalid, totalCount: total });

  test("accepts a file exactly at the limit", () => {
    const rows = Array.from({ length: PURCHASE_IMPORT_MAX_ROWS }, row);
    const b = purchaseBlockers(rows, "CASH", file(PURCHASE_IMPORT_MAX_ROWS));
    expect(b.exceedsRowLimit).toBe(false);
    expect(b.hasInvalidRows).toBe(false);
  });

  test("refuses one row over, so the operator is told to split BEFORE anything is sent", () => {
    const rows = Array.from({ length: PURCHASE_IMPORT_MAX_ROWS + 1 }, row);
    expect(purchaseBlockers(rows, "CASH", file(PURCHASE_IMPORT_MAX_ROWS + 1)).exceedsRowLimit).toBe(
      true
    );
  });

  test("ANY invalid row blocks the whole purchase — no subset import", () => {
    // One atomic transaction over the whole file means the action waits until
    // every row is valid. Importing the valid subset instead is how two cars
    // sharing a filler VIN become one vehicle and one acquisition: the first
    // posts, and the corrected second is later read as a retry of it.
    const rows = Array.from({ length: 3 }, row);
    expect(purchaseBlockers(rows, "CASH", file(4, 1)).hasInvalidRows).toBe(true);
    expect(purchaseBlockers(rows, "CASH", file(3, 0)).hasInvalidRows).toBe(false);
  });

  test("THE DISCRIMINATION: 26 total with 25 valid is BOTH invalid AND still a 26-row file", () => {
    // Correcting the broken row must not quietly turn the same file into an
    // importable one — it is over the limit either way. Measuring the cap
    // against the valid subset alone would do exactly that.
    const rows = Array.from({ length: PURCHASE_IMPORT_MAX_ROWS }, row);
    const b = purchaseBlockers(rows, "CASH", file(PURCHASE_IMPORT_MAX_ROWS + 1, 1));
    expect(b.hasInvalidRows).toBe(true);
    expect(b.exceedsRowLimit).toBe(true);
  });

  test("the client cap IS the shared cap — not a second copy of the number", () => {
    // The previous version of this test asserted `=== 25` twice and would not
    // have failed if the two sides drifted, which is the very drift this
    // codebase warns about. Both sides now read one constant; the convex suite
    // pins the server end of the same chain.
    expect(IMPORT_PURCHASE_MAX_ROWS).toBe(PURCHASE_IMPORT_MAX_ROWS);
  });
});
// ── Money cells ──────────────────────────────────────────────────────────────
//
// `parseFloat` is a PREFIX parser. On a column that decides how much a car cost,
// that turns a typo into a different amount rather than into an error, and the
// import reports success either way. These are the shapes measured on the branch
// before the fix:
//
//   "1O000"      -> 1          a capital O for a zero, off by four orders
//   "10000abc"   -> 10000      trailing junk read as if clean
//   "JOD 10,000" -> NaN        -> undefined -> "no cost" -> imports UNCAPITALIZED
//
// The middle one is the quietest: nothing looks wrong anywhere.

describe("parseMoneyCell — a money cell reads exactly, or it is an error", () => {
  const reads = (raw: unknown, expected: number | undefined) =>
    expect(parseMoneyCell(raw)).toEqual({ ok: true, value: expected });
  const refuses = (raw: unknown) => expect(parseMoneyCell(raw)).toEqual({ ok: false });

  test("reads the shapes a dealer's spreadsheet actually contains", () => {
    reads("10000", 10000);
    reads("10,000", 10000);
    reads("1,234,567", 1234567);
    reads("10000.50", 10000.5);
    reads("10,000.50", 10000.5);
    reads("  10,000  ", 10000);
    reads(-5000, -5000);
    reads("-5000", -5000);
    reads(10000, 10000);
    reads("0", 0);
  });

  test("BLANK is absent, not invalid — the distinction the whole fix rests on", () => {
    // An optional cost that nobody filled in is legitimate; it imports the car
    // without capitalizing it. Only a NON-BLANK cell that cannot be read is an
    // error. Collapsing these two is what made "JOD 10,000" mean "free".
    reads(undefined, undefined);
    reads(null, undefined);
    reads("", undefined);
    reads("   ", undefined);
  });

  test("refuses every cell parseFloat would have silently mangled", () => {
    refuses("1O000");      // capital O — became 1
    refuses("10000abc");   // trailing junk — became 10000
    refuses("JOD 10,000"); // currency in-cell — became "no cost"
    refuses("10,000 JOD");
    refuses("$10,000");
    refuses("10 000");     // space separator — not guessed at
    refuses("1,0000");     // mis-grouped thousands
    refuses("10.");
    refuses(".5");
    refuses("abc");
    refuses(NaN);
    refuses(Infinity);
  });

  test("refuses Arabic-Indic digits rather than mapping them", () => {
    // Fail closed, and no digit table. Refusing "١٠٠٠٠" tells the operator to
    // retype it; mapping it is a decision about numerals that does not belong in
    // an import dialog. (The bare `\d` class is ASCII-only without the `u` flag,
    // which is what makes this true rather than incidental.)
    refuses("١٠٠٠٠");
    refuses("١٠,٠٠٠");
  });
});

describe("a malformed cost is an ERROR on the row, not a different number", () => {
  const withCost = (cost: string) => ({ ...stockRow, purchasePrice: cost });
  const errorsFor = (raw: Record<string, any>) => validateVehicleRow(deriveVehicleRow(raw));

  test("1O000 does not import as 1", () => {
    expect(deriveVehicleRow(withCost("1O000")).purchasePrice).toBeUndefined();
    expect(errorsFor(withCost("1O000")).join(" ")).toMatch(/Unreadable Cost/);
  });

  test("10000abc does not import as 10000", () => {
    expect(errorsFor(withCost("10000abc")).join(" ")).toMatch(/Unreadable Cost/);
  });

  test("JOD 10,000 does not import as a car with no cost at all", () => {
    // The worst of the three: the row was VALID, so it imported, and the car
    // landed in inventory with nothing capitalized against it — the exact
    // SCRUM-59 shape, arriving through the client instead of the server.
    expect(errorsFor(withCost("JOD 10,000")).join(" ")).toMatch(/Unreadable Cost/);
  });

  test("a blank cost is still perfectly valid — it just capitalizes nothing", () => {
    const { purchasePrice: _dropped, ...noCost } = stockRow;
    expect(deriveVehicleRow(noCost).purchasePrice).toBeUndefined();
    expect(errorsFor(noCost)).toEqual([]);
  });

  test("a negative cost is refused before the file is sent", () => {
    expect(errorsFor(withCost("-5000")).join(" ")).toMatch(/Negative Cost/);
  });

  test("an unreadable SELLING price is an error, not a silent zero", () => {
    expect(errorsFor({ ...stockRow, sellingPrice: "15,000 JOD" }).join(" "))
      .toMatch(/Unreadable Selling Price/);
    // Absent has always meant zero and still does.
    const { sellingPrice: _omitted, ...noPrice } = stockRow;
    expect(deriveVehicleRow(noPrice).sellingPrice).toBe(0);
    expect(errorsFor(noPrice)).toEqual([]);
  });

  test("and it blocks the WHOLE purchase file, not just its own row", () => {
    // One atomic transaction over the whole file. A malformed cost anywhere
    // stops all of it, rather than importing the readable rows and leaving the
    // operator to notice one car is missing.
    const good = deriveVehicleRow(stockRow);
    const bad = deriveVehicleRow(withCost("1O000"));
    const invalidCount = [good, bad].filter((r) => validateVehicleRow(r).length > 0).length;
    expect(invalidCount).toBe(1);
    expect(
      purchaseBlockers([good], "CASH", { invalidCount, totalCount: 2 }).hasInvalidRows
    ).toBe(true);
  });
});

// ── What the operator is told afterwards ─────────────────────────────────────

describe("describeImportResult — an unrecorded car is never called a duplicate", () => {
  const en = (key: string) => (commonEn as Record<string, string>)[key];
  const ar = (key: string) => (commonAr as Record<string, string>)[key];

  test("an idempotent retry is reported as already recorded, with its evidence named", () => {
    const message = describeImportResult({ inserted: 17, skipped: 0, alreadyRecorded: 2 }, en);
    expect(message).toContain("Imported 17.");
    expect(message).toContain("2 were already recorded with matching purchase evidence");
    // THE DEFECT: this used to read "Imported 17, skipped 2 duplicates." — the
    // same sentence a lost car produced.
    expect(message).not.toMatch(/duplicate/i);
  });

  test("the generic duplicate wording survives only where it is true", () => {
    // OPENING_STOCK posts nothing, so its skip really is just a duplicate.
    const message = describeImportResult({ inserted: 5, skipped: 2 }, en);
    expect(message).toContain("Skipped 2 duplicates.");
    expect(message).not.toMatch(/already recorded/i);
  });

  test("a clean import says only that", () => {
    expect(describeImportResult({ inserted: 3, skipped: 0 }, en)).toBe("Imported 3.");
  });

  test("both counts appear when both happened, and never merge", () => {
    const message = describeImportResult(
      { inserted: 1, skipped: 2, alreadyRecorded: 3, companiesCreated: 1 },
      en
    );
    expect(message).toContain("Imported 1.");
    expect(message).toContain("3 were already recorded");
    expect(message).toContain("Skipped 2 duplicates.");
    expect(message).toContain("Created 1 new finance");
  });

  test("Arabic says the same things — every key exists and interpolates", () => {
    const message = describeImportResult({ inserted: 17, skipped: 0, alreadyRecorded: 2 }, ar);
    expect(message).toContain("17");
    expect(message).toContain("2");
    // A missing key would render "undefined"; an un-interpolated one keeps the
    // placeholder. Both are the failure this asserts against.
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("{count}");
  });
});
describe("an optional VALUATION never costs the operator the whole car", () => {
  // Regression for a defect this branch introduced and an adversarial reviewer
  // caught: strict money parsing was applied to finance-company valuation
  // columns too, so "N/A" — completely ordinary in the spreadsheets dealers
  // actually send — invalidated the entire vehicle row. In an OPENING_STOCK
  // cutover import the wizard then excluded that car from the migration
  // entirely, because of a column that carries no money at all.
  const withValuation = (value: string) => ({
    ...stockRow,
    "valuation:new:Orange Finance": value,
  });

  test("an unreadable valuation is treated as 'no figure', exactly like blank", () => {
    expect(validateVehicleRow(deriveVehicleRow(withValuation("N/A")))).toEqual([]);
    expect(deriveVehicleRow(withValuation("N/A")).valuations).toEqual([]);
    expect(deriveVehicleRow(withValuation("")).valuations).toEqual([]);
  });

  test("a readable valuation still comes through", () => {
    expect(deriveVehicleRow(withValuation("12,500")).valuations).toEqual([
      { companyName: "Orange Finance", valuationAmount: 12500 },
    ]);
  });

  test("but an unreadable COST still blocks — that is where the money is", () => {
    // The distinction being drawn: strictness belongs on the cells that reach
    // the ledger, not on every numeric column in the sheet.
    expect(
      validateVehicleRow(deriveVehicleRow({ ...stockRow, purchasePrice: "N/A" })).join(" ")
    ).toMatch(/Unreadable Cost/);
  });

  test("an explicit + sign is a number, not a typo", () => {
    expect(parseMoneyCell("+10000")).toEqual({ ok: true, value: 10000 });
    expect(parseMoneyCell("+10,000.50")).toEqual({ ok: true, value: 10000.5 });
    // Still refused: a space is as likely to be two numbers as one.
    expect(parseMoneyCell("10 000")).toEqual({ ok: false });
  });
});
