/**
 * The one question a salesperson is asked about a عربون at the end of a
 * consigned deal, rendered against what the server actually answers.
 *
 * ## Why the fixture is a real preview
 *
 * This component's whole justification is that it never computes money. Every
 * figure and every eligibility decision comes from `sales.consignedSalePreview`,
 * which answers through `planDepositSettlementApplication` — the same function
 * the completion posts through. A hand-written preview object would agree with
 * whatever this author believed on the day and could not catch the one failure
 * that matters: the screen promising something the posting then refuses.
 *
 * So each case builds a real org, chart, quote and عربون, calls the real query,
 * and renders the component with whatever came back.
 *
 * ## What this does NOT cover
 *
 * Whether the screen is legible, and whether it reads correctly in Arabic. Both
 * were checked by rendering the real page; neither is assertable here.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { convexTestWithComponents } from "../../test-utils/convexTest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// Identity translator, so an assertion names the key the component asked for
// rather than a rendering of it. Missing keys are caught by
// lib/i18n/keyCoverage.test.ts, which reads the source.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

// Keyed on the function's path, never on the reference object: `api` is a proxy
// that builds a fresh reference on every property access, so an identity map
// misses every lookup and the component silently renders nothing. `String(ref)`
// throws, so that is not an option either.
const stubs = vi.hoisted(() => ({ queryResults: new Map<string, unknown>() }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
  };
});

const { queryResults } = stubs;

import { DepositSettlementDecision } from "./DepositSettlementDecision";

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "view:customers",
  "manage:finance", "view:finance", "view:expenses", "view:reports",
  "view:deposits", "create:deposits", "manage:deposits",
];

const SALE_PRICE = 12_500;
const SUPPLIER_COST = 9_500;
const MARGIN = SALE_PRICE - SUPPLIER_COST;

/**
 * A consigned car on a quote carrying a عربون, and the preview the server gives
 * for it. `sourceType` STOCK produces the dealer-owned case.
 */
async function seedPreview(
  tag: string,
  opts: {
    deposit: number;
    route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
    sourceCost?: number;
    sourceType?: "SOURCED" | "STOCK";
  }
) {
  const t = convexTestWithComponents(schema, import.meta.glob("../../convex/**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Settle ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Sales" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const sourceType = opts.sourceType ?? "SOURCED";
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSET${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType,
      ...(sourceType === "SOURCED"
        ? { sourcedFromName: "Amman Importer Co", sourceCost: opts.sourceCost ?? SUPPLIER_COST }
        : { purchasePrice: opts.sourceCost ?? SUPPLIER_COST }),
    })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE,
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );
  await asUser.mutation(api.deposits.create, {
    orgId, quoteId, amount: opts.deposit, method: "CASH",
  });

  const preview = await asUser.query(api.sales.consignedSalePreview, {
    orgId, vehicleId, quoteId, settlementRoute: opts.route,
  });
  queryResults.set("sales:consignedSalePreview", preview);

  return { orgId, quoteId, vehicleId, preview };
}

function renderDecision(
  seeded: Awaited<ReturnType<typeof seedPreview>>,
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER",
  value: boolean,
  onChange = vi.fn()
) {
  render(
    <DepositSettlementDecision
      orgId={seeded.orgId as Id<"organizations">}
      quoteId={seeded.quoteId as Id<"quotes">}
      vehicleId={seeded.vehicleId as Id<"vehicles">}
      settlementRoute={route}
      value={value}
      onChange={onChange}
    />
  );
  return onChange;
}

beforeEach(() => {
  cleanup();
  queryResults.clear();
});

describe("DepositSettlementDecision", () => {
  test("on the direct route it says the sale is blocked, and offers the one confirmation", async () => {
    // The buyer paid the supplier, so the dealership invoiced nothing for the
    // car and the عربون cannot come off a bill that was never raised. This is
    // precisely the deal that used to be refused with no way forward.
    const seeded = await seedPreview("direct", { deposit: 1_000, route: "DIRECT_TO_SUPPLIER" });
    expect(seeded.preview?.depositSettlement?.treatmentRequired).toBe(true);

    const onChange = renderDecision(seeded, "DIRECT_TO_SUPPLIER", false);
    expect(screen.getByText("DepositSettlementRequired")).toBeTruthy();

    const confirm = screen.getByRole("checkbox");
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith(seeded.vehicleId, true);
  });

  test("once confirmed it shows what the supplier still owes, net of the deposit", async () => {
    const seeded = await seedPreview("directOn", { deposit: 1_000, route: "DIRECT_TO_SUPPLIER" });
    renderDecision(seeded, "DIRECT_TO_SUPPLIER", true);

    // 3,000 margin less the 1,000 the dealership is already holding in cash.
    expect(screen.getByText((MARGIN - 1_000).toLocaleString("en-JO"))).toBeTruthy();
    expect(screen.getByText("DepositSettlementSupplierOwes")).toBeTruthy();
    // The warning is gone once the decision is made.
    expect(screen.queryByText("DepositSettlementRequired")).toBeNull();
  });

  test("on the through-dealership route it shows what the customer still owes", async () => {
    // Here the dealership collected the gross, so the same confirmation means
    // the عربون comes off the customer's own bill. The operator is not asked to
    // know that — they answer the same question and the server routes it.
    const seeded = await seedPreview("through", { deposit: 1_000, route: "THROUGH_DEALERSHIP" });
    expect(seeded.preview?.depositSettlement?.destination).toBe("CUSTOMER_RECEIVABLE");

    renderDecision(seeded, "THROUGH_DEALERSHIP", true);
    expect(screen.getByText((SALE_PRICE - 1_000).toLocaleString("en-JO"))).toBeTruthy();
    expect(screen.getByText("DepositSettlementCustomerOwes")).toBeTruthy();
  });

  test("a deposit larger than the margin is refused as a reason, never offered as a choice", async () => {
    // Deposits run 5-10% of the price and consignment margins are often
    // smaller, so this is ordinary. Offering the option and letting the sale
    // fail on submit is an error message dressed up as a choice.
    const seeded = await seedPreview("thin", {
      deposit: 1_000,
      route: "DIRECT_TO_SUPPLIER",
      sourceCost: SALE_PRICE - 350,
    });
    expect(seeded.preview?.depositSettlement?.canApplyToSettlement).toBe(false);

    renderDecision(seeded, "DIRECT_TO_SUPPLIER", false);
    expect(screen.getByText("DepositSettlementUnavailable")).toBeTruthy();
    // The server's own sentence, not a client paraphrase of it.
    expect(screen.getByText(/exceeds the dealership's margin/i)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  test("withdraws a confirmation that the route change has invalidated", async () => {
    // The route lives in a sibling panel and the parent holds ONE boolean for
    // the whole deal. Tick this on a route where the عربون fits, correct the
    // route to one where it exceeds the margin, and the checkbox vanishes while
    // the parent's `true` survives — so submitting still sends the treatment and
    // the sale is refused for a reason already on screen, from a control no
    // longer on it to untick.
    const seeded = await seedPreview("stale", {
      deposit: 1_000,
      route: "DIRECT_TO_SUPPLIER",
      sourceCost: SALE_PRICE - 350,
    });
    expect(seeded.preview?.depositSettlement?.canApplyToSettlement).toBe(false);

    const onChange = renderDecision(seeded, "DIRECT_TO_SUPPLIER", true);
    expect(onChange).toHaveBeenCalledWith(seeded.vehicleId, false);
  });

  test("renders nothing at all for the dealership's own stock", async () => {
    // There is no supplier to settle with, and on owned stock "applied" has only
    // ever meant one thing. A section here would be a question with one answer.
    const seeded = await seedPreview("owned", {
      deposit: 1_000,
      route: "THROUGH_DEALERSHIP",
      sourceType: "STOCK",
    });
    expect(seeded.preview).toBeNull();

    const { container } = render(
      <DepositSettlementDecision
        orgId={seeded.orgId as Id<"organizations">}
        quoteId={seeded.quoteId as Id<"quotes">}
        vehicleId={seeded.vehicleId as Id<"vehicles">}
        settlementRoute="THROUGH_DEALERSHIP"
        value={false}
        onChange={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  test("does not withdraw a confirmation while the preview is still loading", async () => {
    // The withdrawal keys on `canApply === false`, and `canApply` is
    // `deposit?.canApplyToSettlement ?? null` — so the loading state is `null`,
    // not `false`. One character (`?? false`) would make every mount silently
    // untick a box the operator had already ticked, before the server has said
    // anything at all.
    queryResults.set("sales:consignedSalePreview", undefined);
    const onChange = vi.fn();
    render(
      <DepositSettlementDecision
        orgId={"o" as Id<"organizations">}
        quoteId={"q" as Id<"quotes">}
        vehicleId={"v" as Id<"vehicles">}
        settlementRoute="DIRECT_TO_SUPPLIER"
        value={true}
        onChange={onChange}
      />
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  test("hides the held amount until the split has been decided", async () => {
    // The server sends 0 there because no share exists yet, and rendering it
    // read "Deposit held on this car — 0" directly above "this car's share has
    // not been decided": a figure stated and then denied.
    const seeded = await seedPreview("undecided", {
      deposit: 1_000,
      route: "DIRECT_TO_SUPPLIER",
    });
    // Force the undecided shape the server produces for a multi-car quote whose
    // split nobody has recorded yet.
    queryResults.set("sales:consignedSalePreview", {
      ...seeded.preview,
      depositSettlement: {
        ...seeded.preview!.depositSettlement,
        allocationDecided: false,
        depositAmount: 0,
        canApplyToSettlement: false,
        blockedReason: "share not decided",
      },
    });
    renderDecision(seeded, "DIRECT_TO_SUPPLIER", false);

    expect(screen.getByText("DepositSettlementNotDecided")).toBeTruthy();
    expect(screen.queryByText("DepositSettlementHeldAmount")).toBeNull();
  });

  test("renders nothing while the preview has not answered", async () => {
    // convex/react returns undefined before the first result. Reserving space
    // for a section that may not exist is a layout shift on every deal.
    const { container } = render(
      <DepositSettlementDecision
        orgId={"x" as Id<"organizations">}
        quoteId={"y" as Id<"quotes">}
        vehicleId={"z" as Id<"vehicles">}
        settlementRoute="THROUGH_DEALERSHIP"
        value={false}
        onChange={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
