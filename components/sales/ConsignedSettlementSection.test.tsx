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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

type Route = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

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

function renderRoute(props: { value: Route; onChange?: () => void }) {
  const onChange = props.onChange ?? vi.fn();
  const view = render(
    <ConsignedSettlementSection
      orgId={ORG}
      vehicleId={CAR}
      quoteId={QUOTE}
      value={props.value}
      onChange={onChange}
      onApplicable={vi.fn()}
    />
  );
  return { onChange, rerender: view.rerender };
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

/**
 * The section never chooses the settlement route for the operator.
 *
 * This component used to correct a stale selection itself: switching a deal to
 * FINANCED with DIRECT_TO_SUPPLIER already chosen fired an effect that called
 * `onChange("THROUGH_DEALERSHIP")`. The financing control sits below this
 * section in the same form, so the route flipped off-screen with no toast and no
 * field error, and the server refusal — the thing that existed to stop exactly
 * that deal — never fired, because by submit time the value was the one route
 * the server accepted.
 *
 * What posted instead was not a smaller mistake than a failed save. The sale
 * booked a supplier payable for the whole entitlement the dealership does not
 * owe, a customer receivable at the gross it will never collect, and no supplier
 * receivable for the margin the supplier owes it.
 *
 * The refusal that motivated the effect is gone — a financed consigned deal can
 * now settle directly, with the finance company's side recorded on the
 * application. **The prohibition on rewriting the operator's choice is not**,
 * and it never depended on the refusal: a control that silently changes a
 * financial decision is wrong whether or not the server would have caught it.
 * `financed` is no longer a prop precisely so that no future condition can be
 * hung off it here.
 */
describe("the settlement route is never chosen for the operator", () => {
  beforeEach(() => {
    queryResults.set("sales:consignedSalePreview", CONSIGNED_PREVIEW);
  });

  test("re-rendering does not rewrite the route", async () => {
    const { onChange, rerender } = renderRoute({ value: "DIRECT_TO_SUPPLIER" });
    await screen.findByText("RouteDirectToSupplier");

    // Whatever changes elsewhere in the form, this section re-renders without
    // touching the selection.
    rerender(
      <ConsignedSettlementSection
        orgId={ORG}
        vehicleId={CAR}
        quoteId={QUOTE}
        value="DIRECT_TO_SUPPLIER"
        onChange={onChange}
        onApplicable={vi.fn()}
      />
    );

    // Give any effect the chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("both routes are selectable, and the operator's stays selected", async () => {
    const { onChange } = renderRoute({ value: "DIRECT_TO_SUPPLIER" });

    const direct = await screen.findByRole("radio", { name: /RouteDirectToSupplier/ });
    const through = screen.getByRole("radio", { name: /RouteThroughDealership/ });
    // Neither is disabled: the deal being financed no longer removes a route.
    expect((direct as HTMLButtonElement).disabled).toBe(false);
    expect((through as HTMLButtonElement).disabled).toBe(false);
    expect(direct.getAttribute("aria-checked")).toBe("true");
    expect(through.getAttribute("aria-checked")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });
});
