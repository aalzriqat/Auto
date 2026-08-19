import { describe, expect, test } from "vitest";

import { PURCHASE_IMPORT_MAX_ROWS } from "@/convex/utils/importLimits";
import {
  IMPORT_PURCHASE_MAX_ROWS,
  deriveVehicleRow,
  purchaseBlockers,
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
