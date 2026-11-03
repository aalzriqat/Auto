/**
 * SCRUM-889 (round-3 M1). supplierPayablesUnavailableWarning chooses the close warning for an UNAVAILABLE
 * supplier-payables reconciliation by its reason. Before this change INCONSISTENT_REFERENCE and
 * OPENING_SOURCE_UNAVAILABLE fell through to the "too many records to verify" text, so the close dialog and
 * the signed close record (which matches acknowledged warnings by exact string) named the wrong cause.
 */
import { describe, expect, test } from "vitest";
import {
  SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING,
  SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING,
  SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
  SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
  SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING,
  supplierPayablesUnavailableWarning,
} from "./closeWarnings";

describe("SCRUM-889 - supplierPayablesUnavailableWarning names the true cause", () => {
  test("INCONSISTENT_REFERENCE gets its own warning, not the too-many-records text", () => {
    const warning = supplierPayablesUnavailableWarning("INCONSISTENT_REFERENCE");
    expect(SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING).toBeTruthy();
    expect(warning).toBe(SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING);
    expect(warning).not.toBe(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING);
    expect(warning).not.toMatch(/too many records/i);
  });

  test("OPENING_SOURCE_UNAVAILABLE gets its own warning, not the too-many-records text", () => {
    const warning = supplierPayablesUnavailableWarning("OPENING_SOURCE_UNAVAILABLE");
    expect(SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING).toBeTruthy();
    expect(warning).toBe(SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING);
    expect(warning).not.toBe(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING);
    expect(warning).not.toMatch(/too many records/i);
  });

  test("the two new warnings differ from each other and from every existing warning", () => {
    const all = [
      SUPPLIER_PAYABLES_RECON_INCONSISTENT_REFERENCE_WARNING,
      SUPPLIER_PAYABLES_RECON_OPENING_SOURCE_WARNING,
      SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING,
      SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING,
      SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING,
    ];
    expect(all.every(Boolean)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  test("CONTROL: the existing reasons keep their warnings, and an unnamed reason keeps the too-many-records text", () => {
    expect(supplierPayablesUnavailableWarning("PENDING_POSTINGS")).toBe(SUPPLIER_PAYABLES_RECON_PENDING_POSTINGS_WARNING);
    expect(supplierPayablesUnavailableWarning("POST_CUTOFF_ACTIVITY")).toBe(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
    expect(supplierPayablesUnavailableWarning("INVALID_DATE")).toBe(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
    expect(supplierPayablesUnavailableWarning("OVER_LIMIT")).toBe(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING);
    expect(supplierPayablesUnavailableWarning(undefined)).toBe(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING);
    expect(SUPPLIER_PAYABLES_RECON_OVER_LIMIT_WARNING).toBe(
      "Supplier payables reconciliation could not be completed: there are too many records to verify in one pass. Review supplier payables manually.",
    );
  });
});