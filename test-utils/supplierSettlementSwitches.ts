/** Historical lifecycle tests only; never imported by the shipped-state containment tests. */
type Original = typeof import("../convex/utils/supplierSettlementContainment");

export function openSupplierSettlementDoors(original: Original): Original {
  return {
    ...original,
    assertSupplierSettlementDoorAllowed: () => undefined,
    isSupplierSettlementDoorDisabled: () => false,
  };
}
