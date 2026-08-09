/**
 * The settlement-route half of the sale form's refusals.
 *
 * The defect these pin: the settlement section used to correct a stale
 * DIRECT_TO_SUPPLIER selection to THROUGH_DEALERSHIP by itself when the deal
 * became financed. THROUGH_DEALERSHIP is the one route the server accepts, so
 * the correction guaranteed the server refusal could never fire, and the deal
 * posted on the wrong side of the balance sheet instead of failing loudly.
 */
import { describe, expect, test } from "vitest";
import { consignedRouteRefusal } from "./consignedRouteGuard";

describe("the sale form's consigned settlement-route guard", () => {
  test("refuses a financed consigned deal paying the supplier directly", () => {
    expect(
      consignedRouteRefusal({
        financed: true,
        route: "DIRECT_TO_SUPPLIER",
        isConsigned: true,
        status: "COMPLETED",
      })
    ).toBe("DIRECT_UNSUPPORTED_ON_FINANCED");
  });

  test("lets a draft be saved, and a sale be cancelled, without changing the route", () => {
    // Only the transition that POSTS is refused. The same guard one function
    // over got this wrong first (`consignedTaxRefusal`): an unscoped refusal
    // blocked the CANCEL path, so the operator was told to change the route
    // "to record it" on a deal they were trying NOT to record — and the submit
    // they needed was the disabled one. A draft and a cancellation post
    // nothing, so there is nothing there to refuse.
    for (const status of ["PENDING", "CANCELLED"] as const) {
      expect(
        consignedRouteRefusal({
          financed: true,
          route: "DIRECT_TO_SUPPLIER",
          isConsigned: true,
          status,
        })
      ).toBeNull();
    }
  });

  test("lets a cash consigned deal pay the supplier directly", () => {
    // The route exists precisely for this case, and the fix for the financed
    // deal must not take it away from the deal it was built for.
    expect(
      consignedRouteRefusal({
        financed: false,
        route: "DIRECT_TO_SUPPLIER",
        isConsigned: true,
        status: "COMPLETED",
      })
    ).toBeNull();
  });

  test("lets a financed consigned deal settle through the dealership", () => {
    expect(
      consignedRouteRefusal({
        financed: true,
        route: "THROUGH_DEALERSHIP",
        isConsigned: true,
        status: "COMPLETED",
      })
    ).toBeNull();
  });

  test("says nothing about the dealership's own stock", () => {
    // No supplier to settle with, so the route is not a question at all.
    expect(
      consignedRouteRefusal({
        financed: true,
        route: "DIRECT_TO_SUPPLIER",
        isConsigned: false,
        status: "COMPLETED",
      })
    ).toBeNull();
  });

  test("says nothing while the car's basis is still unknown", () => {
    // The preview has not answered. Refusing here would block a deal on a
    // guess; the server still holds the line at the mutation boundary.
    expect(
      consignedRouteRefusal({
        financed: true,
        route: "DIRECT_TO_SUPPLIER",
        isConsigned: undefined,
        status: "COMPLETED",
      })
    ).toBeNull();
  });

  test("says nothing while the route itself is unset", () => {
    expect(
      consignedRouteRefusal({ financed: true, route: undefined, isConsigned: true, status: "COMPLETED" })
    ).toBeNull();
  });
});
