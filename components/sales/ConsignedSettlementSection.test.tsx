/**
 * Which line of a quote carries the settlement-route selector.
 *
 * The route is one decision for the whole deal, so it is asked for once — and
 * "once" used to mean "on line 0". A quote whose first car is the dealership's
 * own stock renders nothing for that line (this component returns null when the
 * preview says the car has no supplier), so on every mixed quote the control
 * vanished entirely and the deal posted the THROUGH_DEALERSHIP default with the
 * operator never asked which way the buyer's money went. That is silently wrong
 * books rather than a refusal, which is the worst kind.
 *
 * Only the server can say whether a line is consigned, so the section reports
 * it up and the caller puts the selector on the first line that actually has a
 * supplier. These tests pin that contract.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

// Keyed on the function's path — `api` is a proxy handing back a fresh
// reference per property access, so an identity map misses every lookup.
const stubs = vi.hoisted(() => ({ queryResults: new Map<string, unknown>() }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
  };
});

const { queryResults } = stubs;

import { ConsignedSettlementSection } from "./ConsignedSettlementSection";

const ORG = "org1" as Id<"organizations">;
const QUOTE = "quote1" as Id<"quotes">;
const CAR = "car1" as Id<"vehicles">;

/** The shape `sales.consignedSalePreview` returns for a consigned line. */
const CONSIGNED_PREVIEW = {
  supplierName: "Amman Importer Co",
  settlementRoute: "THROUGH_DEALERSHIP" as const,
  quoteLineIndex: 1,
  vehicleLabel: "2024 Toyota Camry",
  salePrice: 12_500,
  grossTransactionValue: 12_500,
  supplierEntitlement: 9_500,
  dealershipMargin: 3_000,
  recognizedRevenue: 3_000,
  customerVehicleReceivable: 12_500,
  supplierPayable: 9_500,
  supplierReceivable: 0,
  missingSupplierCost: false,
  depositSettlement: null,
};

function renderSection(onApplicable = vi.fn()) {
  render(
    <ConsignedSettlementSection
      orgId={ORG}
      vehicleId={CAR}
      quoteId={QUOTE}
      value="THROUGH_DEALERSHIP"
      onChange={vi.fn()}
      onApplicable={onApplicable}
    />
  );
  return onApplicable;
}

beforeEach(() => {
  cleanup();
  queryResults.clear();
});

describe("ConsignedSettlementSection reports whether its line is consigned", () => {
  test("reports true for a consigned car, so the caller can put the selector on it", async () => {
    queryResults.set("sales:consignedSalePreview", CONSIGNED_PREVIEW);
    const onApplicable = renderSection();
    await waitFor(() => expect(onApplicable).toHaveBeenCalledWith(CAR, true));
  });

  test("reports false for dealer-owned stock, where it renders nothing at all", async () => {
    // `null` is the server saying this car has no supplier. Without this report
    // the caller cannot tell "not consigned" from "still loading", and keying
    // the selector to line 0 loses it on every mixed quote.
    queryResults.set("sales:consignedSalePreview", null);
    const onApplicable = renderSection();
    await waitFor(() => expect(onApplicable).toHaveBeenCalledWith(CAR, false));
  });

  test("stays silent while the preview has not answered", async () => {
    // `undefined` is "not answered yet", and reporting it as "not consigned"
    // would move the selector onto another line and then move it back — a
    // control that jumps between cars as queries land.
    queryResults.set("sales:consignedSalePreview", undefined);
    const onApplicable = renderSection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onApplicable).not.toHaveBeenCalled();
  });
});
