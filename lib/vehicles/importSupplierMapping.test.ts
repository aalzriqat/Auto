/**
 * SCRUM-868 P2: the import file carries supplier NAMES; the server stores only what it resolves from an
 * id. The mapping is the dealer's explicit act, one entry per distinct spelling and role, never a match
 * by name.
 */
import { describe, expect, test } from "vitest";
import {
  importRowSupplierIds,
  importSupplierKey,
  importSupplierNeeds,
  unmappedImportSuppliers,
  type ImportSupplierContext,
} from "./importSupplierMapping";
import { ownershipGaps } from "./ownershipGaps";

const purchaseOnAccount: ImportSupplierContext = { posting: "PURCHASE", paymentMethod: "ON_ACCOUNT" };
const openingStock: ImportSupplierContext = { posting: "OPENING_STOCK", paymentMethod: null };

describe("importSupplierNeeds", () => {
  test("lists each distinct consignment supplier once, with its row count, in first-seen order", () => {
    const needs = importSupplierNeeds(
      [
        { sourceType: "SOURCED", sourcedFromName: "Gulf Motors" },
        { sourceType: "SOURCED", sourcedFromName: " Gulf Motors " },
        { sourceType: "SOURCED", sourcedFromName: "Atiwi" },
      ],
      openingStock,
    );
    expect(needs).toEqual([
      { key: "SOURCED:Gulf Motors", role: "SOURCED", name: "Gulf Motors", rowCount: 2 },
      { key: "SOURCED:Atiwi", role: "SOURCED", name: "Atiwi", rowCount: 1 },
    ]);
  });

  test("never merges spellings: case and spacing variants are separate entries the dealer maps one by one (N2)", () => {
    const needs = importSupplierNeeds(
      [
        { sourceType: "SOURCED", sourcedFromName: "Gulf Motors" },
        { sourceType: "SOURCED", sourcedFromName: "gulf motors" },
        { sourceType: "SOURCED", sourcedFromName: "Gulf  Motors" },
      ],
      openingStock,
    );
    expect(needs.map((n) => n.name)).toEqual(["Gulf Motors", "gulf motors", "Gulf  Motors"]);
  });

  test("a creditor is needed only by an owned, priced row of a PURCHASE import paid ON_ACCOUNT", () => {
    const row = { sourceType: "STOCK", purchaseSupplierName: "Credit Co", purchasePrice: 10_000 };
    expect(importSupplierNeeds([row], purchaseOnAccount)).toHaveLength(1);
    expect(importSupplierNeeds([row], { posting: "PURCHASE", paymentMethod: "CASH" })).toEqual([]);
    expect(importSupplierNeeds([row], openingStock)).toEqual([]);
    expect(importSupplierNeeds([{ ...row, purchasePrice: 0 }], purchaseOnAccount)).toEqual([]);
    expect(importSupplierNeeds([{ ...row, purchaseSupplierName: "  " }], purchaseOnAccount)).toEqual([]);
  });

  test("the same company in both roles is two separate entries (N9)", () => {
    const needs = importSupplierNeeds(
      [
        { sourceType: "SOURCED", sourcedFromName: "Gulf Motors" },
        { sourceType: "STOCK", purchaseSupplierName: "Gulf Motors", purchasePrice: 5000 },
      ],
      purchaseOnAccount,
    );
    expect(needs.map((n) => n.role)).toEqual(["SOURCED", "CREDITOR"]);
    expect(needs[0].key).not.toBe(needs[1].key);
  });
});

describe("unmappedImportSuppliers", () => {
  const needs = importSupplierNeeds(
    [
      { sourceType: "SOURCED", sourcedFromName: "Gulf Motors" },
      { sourceType: "SOURCED", sourcedFromName: "Atiwi" },
    ],
    openingStock,
  );

  test("every need is unmapped until the dealer picks a supplier for it", () => {
    expect(unmappedImportSuppliers(needs, {})).toHaveLength(2);
    expect(unmappedImportSuppliers(needs, { [importSupplierKey("SOURCED", "Gulf Motors")]: { id: "sup_gulf" } })).toHaveLength(1);
  });

  test("an entry with an empty id is still unmapped", () => {
    expect(unmappedImportSuppliers(needs, { [needs[0].key]: { id: "" }, [needs[1].key]: undefined })).toHaveLength(2);
  });

  test("all mapped leaves nothing blocking the import", () => {
    const mapped = { [needs[0].key]: { id: "sup_gulf" }, [needs[1].key]: { id: "sup_atiwi" } };
    expect(unmappedImportSuppliers(needs, mapped)).toEqual([]);
  });
});

describe("importRowSupplierIds", () => {
  const mapped = {
    "SOURCED:Gulf Motors": { id: "sup_gulf" },
    "CREDITOR:Credit Co": { id: "sup_credit" },
  };

  test("a consignment row sends the consignment id only", () => {
    expect(importRowSupplierIds({ sourceType: "SOURCED", sourcedFromName: "Gulf Motors" }, openingStock, mapped)).toEqual({
      sourcedSupplierId: "sup_gulf",
    });
  });

  test("an on-account row sends the creditor id only", () => {
    expect(
      importRowSupplierIds({ sourceType: "STOCK", purchaseSupplierName: "Credit Co", purchasePrice: 9000 }, purchaseOnAccount, mapped),
    ).toEqual({ purchaseSupplierId: "sup_credit" });
  });

  test("the role decides the entry: a creditor name never picks up the consignment mapping of the same spelling", () => {
    expect(
      importRowSupplierIds(
        { sourceType: "STOCK", purchaseSupplierName: "Gulf Motors", purchasePrice: 9000 },
        purchaseOnAccount,
        mapped,
      ),
    ).toEqual({});
  });

  test("a row that needs no supplier sends none, even with a leftover name", () => {
    expect(importRowSupplierIds({ sourceType: "STOCK", purchaseSupplierName: "Credit Co", purchasePrice: 9000 }, openingStock, mapped)).toEqual({});
    expect(importRowSupplierIds({ sourceType: "STOCK", sourcedFromName: "Gulf Motors" }, openingStock, mapped)).toEqual({});
  });
});

describe("ownershipGaps with supplier ids (SCRUM-868 P2)", () => {
  const sourced = { sourceType: "SOURCED", sourceCost: 9000 };
  const noCost = { typeRequired: true, costRequired: true, purchaseTerms: "required" as const };

  test("a consignment car with a picked supplier id has no supplier gap", () => {
    expect(ownershipGaps({ ...sourced, sourcedSupplierId: "sup_gulf" }, noCost)).toBeNull();
  });

  test("a consignment car with neither an id nor a stored name needs a supplier", () => {
    expect(ownershipGaps(sourced, noCost)).toEqual({ field: "sourcedFromName", reason: "SUPPLIER_REQUIRED" });
  });

  test("a legacy car's stored name still satisfies an ordinary edit (the server ignores an unchanged echo)", () => {
    expect(ownershipGaps({ ...sourced, sourcedFromName: "Gulf Motors" }, { ...noCost, typeRequired: false })).toBeNull();
  });

  test("an on-account purchase needs the creditor id (or a legacy stored name)", () => {
    const owned = { sourceType: "STOCK", purchasePrice: 10_000, purchasePaymentMethod: "ON_ACCOUNT" };
    expect(ownershipGaps(owned, noCost)).toEqual({ field: "purchaseSupplierName", reason: "CREDITOR_REQUIRED" });
    expect(ownershipGaps({ ...owned, purchaseSupplierId: "sup_credit" }, noCost)).toBeNull();
  });
});
