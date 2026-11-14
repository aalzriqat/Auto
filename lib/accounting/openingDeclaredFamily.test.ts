/**
 * SCRUM-944: the single rule for "a declared opening control holds one allocation family". The posting validator,
 * the reconciliation reader and the entry screen all read it, so these cases pin the rule and its two refusal
 * messages, which the posting door has always returned verbatim.
 */
import { describe, expect, test } from "vitest";
import { openingDeclaredFamilyConflict, openingDeclaredFamilyRefusal, isRemainingOpeningKind } from "./openingDeclaredFamily";
import * as policy from "../../convex/utils/openingAccountPolicy";

describe("SCRUM-944 openingDeclaredFamilyConflict", () => {
  test("no rows, or rows of two kinds, are a mixed family with the original refusal text", () => {
    expect(openingDeclaredFamilyConflict([])).toBe("NO_FAMILY");
    expect(openingDeclaredFamilyConflict([{ kind: "OTHER_PAYABLE" }, { kind: "SUPPLIER_PAYABLE" }])).toBe("MIXED_KIND");
    expect(openingDeclaredFamilyRefusal([{ kind: "OTHER_PAYABLE" }, { kind: "SUPPLIER_PAYABLE" }]))
      .toBe("Every opening control needs one explicitly declared allocation family.");
    expect(openingDeclaredFamilyRefusal([])).toBe("Every opening control needs one explicitly declared allocation family.");
  });

  test("unidentified pools with different purposes, or one purpose missing, are refused with the pool text", () => {
    const pool = (purpose?: string) => ({ kind: "UNALLOCATED_LIABILITY", purpose });
    expect(openingDeclaredFamilyConflict([pool("CUSTOMER_DEPOSIT"), pool("UNIDENTIFIED_RECEIPT")])).toBe("MIXED_PURPOSE");
    expect(openingDeclaredFamilyConflict([pool("CUSTOMER_DEPOSIT"), pool()])).toBe("MIXED_PURPOSE");
    expect(openingDeclaredFamilyRefusal([pool("CUSTOMER_DEPOSIT"), pool("UNIDENTIFIED_RECEIPT")]))
      .toBe("Unidentified opening pools need separate declared controls.");
  });

  test("uniform families are accepted, and purpose only matters for unidentified pools", () => {
    expect(openingDeclaredFamilyConflict([{ kind: "OTHER_PAYABLE" }, { kind: "OTHER_PAYABLE" }])).toBeNull();
    expect(openingDeclaredFamilyConflict([{ kind: "SUPPLIER_RECOVERABLE", purpose: "CLAIM" }, { kind: "SUPPLIER_RECOVERABLE", purpose: "REFUNDABLE_DEPOSIT" }])).toBeNull();
    expect(openingDeclaredFamilyConflict([{ kind: "UNALLOCATED_LIABILITY", purpose: "CUSTOMER_DEPOSIT" }, { kind: "UNALLOCATED_LIABILITY", purpose: "CUSTOMER_DEPOSIT" }])).toBeNull();
  });

  test("the policy module re-exports this same rule for its existing callers", () => {
    expect(policy.openingDeclaredFamilyRefusal).toBe(openingDeclaredFamilyRefusal);
    expect(policy.isRemainingOpeningKind).toBe(isRemainingOpeningKind);
    expect(isRemainingOpeningKind("CUSTOMER_DEPOSIT")).toBe(true);
    expect(isRemainingOpeningKind("VEHICLE_INVENTORY")).toBe(false);
  });
});