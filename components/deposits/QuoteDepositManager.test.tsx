/**
 * The deposit screen, rendered against data the server actually produced.
 *
 * ## Why the fixtures come from Convex rather than from a literal
 *
 * Every defect this screen has shipped was a disagreement between what the
 * server returns and what the component believed it returned. A hand-written
 * fixture agrees with whatever the test author believed on the day, so it
 * cannot catch that class of thing at all — the fixture and the bug are written
 * by the same misunderstanding.
 *
 * So each case below builds a real quote through `api.deposits.create`,
 * `allocateToVehicles`, `sales.create` and `sales.update`, and then calls
 * `api.deposits.quoteAllocation` for real. Whatever that returns is what the
 * component is rendered with. The shapes that matter are the ones production
 * makes and nothing else does:
 *
 *  - a عربون paid in TWO instalments, so a car's share is spread across two
 *    payment rows and comes back as two shares, not one;
 *  - a share whose reversing journal is queued behind a closed accounting
 *    period, which is waiting on the ledger rather than on a person.
 *
 * ## What is NOT covered here, and why
 *
 * RECEPTION cannot reach this component at all — the customer dialog gates the
 * mount — so there is nothing to render for that role. What matters for it is
 * that the gate exists and that the query genuinely refuses the role, and both
 * are asserted below against the server and the source rather than pretended at
 * in jsdom.
 *
 * This is not a substitute for looking at the rendered page. It catches wrong
 * numbers, wrong affordances and crashes; it says nothing about whether the
 * screen is legible.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { convexTestWithComponents } from "../../test-utils/convexTest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// The translator is the identity on the key, so an assertion names the string
// the component asked for rather than a rendering of it. A missing key is
// caught by lib/i18n/keyCoverage.test.ts, which reads the source.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Keyed on the function's path.
//
// Not on the reference object: `api` is a proxy that builds a fresh reference
// on every property access, so `api.deposits.quoteAllocation !==
// api.deposits.quoteAllocation` and an identity map silently misses every
// lookup — the component renders its empty state and the assertions fail for
// the wrong reason. Not on `String(reference)` either: coercing one throws.
const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  mutationCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      stubs.mutationCalls.push({ name: getFunctionName(reference), args });
    },
  };
});

const { queryResults, mutationCalls } = stubs;

let permissions: string[] = [];
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    permissions,
    isLoading: false,
    isOwner: false,
    hasPermission: (permission: string) => permissions.includes(permission),
    hasAnyPermission: (perms: string[]) => perms.some((p) => permissions.includes(p)),
    hasAllPermissions: (perms: string[]) => perms.every((p) => permissions.includes(p)),
    role: undefined,
  }),
}));

const PERMS_MANAGER = [
  "view:sales", "create:sales", "edit:sales", "delete:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "manage:finance", "view:finance", "view:expenses", "view:reports",
  "reopen:accounting_periods",
];
/** The default SALES template's shape: it can sell, it cannot approve. */
const PERMS_SALES = PERMS_MANAGER.filter((p) => p !== "approve:requests");
/** RECEPTION: customers, and nothing about sales. */
const PERMS_RECEPTION = ["view:customers", "create:customers"];

const PRICE_A = 3_000;
const PRICE_B = 20_000;
const SCALE = 1000;

async function seedQuote(tag: string, rolePermissions: string[] = PERMS_MANAGER) {
  const t = convexTestWithComponents(schema, import.meta.glob("../../convex/**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Deposit ${tag}`, createdAt: Date.now() })
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
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS_MANAGER })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "Manager" })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Manager", permissions: PERMS_MANAGER })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
  );
  // The role whose permissions this render is about.
  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_v`, email: `${tag}v@e.com`, name: "Viewer" })
  );
  const viewerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Viewer", permissions: rolePermissions })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
  const asViewer = t.withIdentity({ subject: `${tag}_v`, clerkId: `${tag}_v` });
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
  const makeVehicle = async (suffix: string, price: number) =>
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VINUI${tag}${suffix}`, make: "Toyota", model: `M${suffix}`,
        year: 2024, mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: price, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: Math.round(price * 0.8),
      })
    );
  const vehicleA = await makeVehicle("A", PRICE_A);
  const vehicleB = await makeVehicle("B", PRICE_B);
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId: vehicleA, vehiclePrice: PRICE_A + PRICE_B,
      vehicleItems: [
        { vehicleId: vehicleA, unitPrice: PRICE_A },
        { vehicleId: vehicleB, unitPrice: PRICE_B },
      ],
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );

  return {
    t, orgId, userId, customerId, vehicleA, vehicleB, quoteId, periodId: period._id,
    asUser, asManager, asViewer,
  };
}

type Seed = Awaited<ReturnType<typeof seedQuote>>;

const payDeposit = (s: Seed, amount: number) =>
  s.asUser.mutation(api.deposits.create, {
    orgId: s.orgId, quoteId: s.quoteId, amount, method: "CASH" as const,
  });

const allocate = (s: Seed, allocations: Array<{ vehicleId: Id<"vehicles">; amount: number }>) =>
  s.asUser.mutation(api.deposits.allocateToVehicles, {
    orgId: s.orgId, quoteId: s.quoteId, allocations,
  });

const sell = (s: Seed, vehicleId: Id<"vehicles">, salePrice: number) =>
  s.asUser.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice, saleDate: Date.now(), status: "COMPLETED" as const, quoteId: s.quoteId,
  });

const cancel = (s: Seed, saleId: Id<"sales">) =>
  s.asManager.mutation(api.sales.update, {
    orgId: s.orgId, saleId, status: "CANCELLED" as const,
  });

/**
 * Picks a treatment on the Radix select attached to a given decision row.
 *
 * Radix renders a listbox rather than a native `<select>`, so an earlier
 * version of these tests looked for `document.querySelector("select")`, found
 * nothing, and skipped every assertion behind an `if`. The tests passed and
 * covered none of it — which is the failure mode the whole permission case
 * exists to rule out.
 */
function chooseTreatment(row: HTMLElement, label: string) {
  const trigger = row.querySelector("[role='combobox']") as HTMLElement;
  // Opened by keyboard rather than pointer: jsdom has no PointerEvent, and the
  // synthetic pointerdown Radix listens for does not carry the button/ctrlKey
  // it checks. The keyboard path is a real one for users anyway.
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  const option = screen.getByText(label);
  fireEvent.click(option);
}

/** The real query answer, put where the mocked `useQuery` will find it. */
async function renderWith(s: Seed, rolePermissions: string[]) {
  const allocation = await s.asUser.query(api.deposits.quoteAllocation, {
    orgId: s.orgId,
    quoteId: s.quoteId,
  });
  queryResults.set(getFunctionName(api.deposits.quoteAllocation), allocation);
  permissions = rolePermissions;

  const { QuoteDepositManager } = await import("./QuoteDepositManager");
  render(<QuoteDepositManager orgId={s.orgId} quoteId={s.quoteId} />);
  return allocation;
}

// jsdom implements none of the pointer-capture surface Radix reaches for, and
// throws rather than no-oping. Without these the select never opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  cleanup();
  queryResults.clear();
  mutationCalls.length = 0;
  permissions = [];
  vi.restoreAllMocks();
});

describe("a deposit paid in two instalments, on screen", () => {
  /** Two payments, both cars allocated, A sold and then cancelled. */
  async function twoPaymentsWithACancelled(tag: string) {
    const s = await seedQuote(tag);
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_500 },
      { vehicleId: s.vehicleB, amount: 1_500 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A + 1_000);
    await cancel(s, saleA);
    return s;
  }

  test("shows each released share at its own amount, not the car's total", async () => {
    // A's 3,500 is spread across the two payments — 3,000 of the first and 500
    // of the second — so it comes back as two shares. The screen printed the
    // car's total beside each of them, showing 7,000 where 3,500 exists, and an
    // operator forfeiting "3,500" forfeited 3,000.
    const s = await twoPaymentsWithACancelled("twoShares");
    const allocation = await renderWith(s, PERMS_MANAGER);

    const shares = allocation!.vehicles.find((v) => v.vehicleId === s.vehicleA)!.awaitingDecision;
    expect(shares.map((share) => share.amountMinor).sort((a, b) => a - b)).toEqual([
      500 * SCALE,
      3_000 * SCALE,
    ]);

    const rendered = screen.getAllByText("DepositRecordDecision");
    expect(rendered).toHaveLength(2);

    // Each row shows its OWN share. Read from the rows themselves rather than
    // the page, because 3,500 legitimately appears above as the bucket total —
    // the defect was that it appeared as BOTH rows' amount as well.
    const rowAmounts = rendered.map(
      (button) =>
        button.closest("div.space-y-2")?.querySelector("p span.tabular-nums")
          ?.textContent ?? ""
    );
    expect(rowAmounts.sort()).toEqual(["3,000", "500"].sort());
    expect(rowAmounts.some((amount) => amount === "3,500")).toBe(false);
  });

  test("the shares on screen add up to the bucket above them", async () => {
    const s = await twoPaymentsWithACancelled("sharesSum");
    const allocation = await renderWith(s, PERMS_MANAGER);

    const total = allocation!.vehicles
      .flatMap((v) => v.awaitingDecision)
      .reduce((sum, share) => sum + share.amountMinor, 0);
    expect(total).toBe(allocation!.releasedAwaitingDecisionMinor);
    expect(total).toBe(3_500 * SCALE);
  });

  test("a car whose share is spent is not offered as somewhere to move money", async () => {
    // The server rejects it, so offering it produces an error toast where a
    // filtered list would have produced nothing at all.
    const s = await seedQuote("targetFilter");
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_500 },
      { vehicleId: s.vehicleB, amount: 1_500 },
    ]);
    await sell(s, s.vehicleB, PRICE_B);
    const saleA = await sell(s, s.vehicleA, PRICE_A + 1_000);
    await cancel(s, saleA);
    const allocation = await renderWith(s, PERMS_MANAGER);

    expect(
      allocation!.vehicles.find((v) => v.vehicleId === s.vehicleB)!.status
    ).toBe("APPLIED");
    // The reallocation control only lists cars that could actually take it.
    const options = allocation!.vehicles.filter(
      (other) =>
        other.vehicleId !== s.vehicleA &&
        other.status !== "APPLIED" &&
        other.status !== "REVERSING"
    );
    expect(options).toHaveLength(0);
  });
});

describe("a share whose reversal is still queued", () => {
  test("is shown as waiting on the ledger, with nothing to decide", async () => {
    // Cancelling into a closed period leaves the reversing journal in the
    // outbox and the original entry POSTED, so the server refuses every
    // treatment. Offering four of them is an error message dressed as a choice.
    const s = await seedQuote("reversingRender");
    await payDeposit(s, 3_000);
    await payDeposit(s, 2_000);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_500 },
      { vehicleId: s.vehicleB, amount: 1_500 },
    ]);
    const saleA = await sell(s, s.vehicleA, PRICE_A + 1_000);
    const checklist = await s.asUser.query(api.accountingPeriods.closeChecklist, {
      orgId: s.orgId,
      periodId: s.periodId,
    });
    await s.asUser.mutation(api.accountingPeriods.close, {
      orgId: s.orgId,
      periodId: s.periodId,
      acknowledgedWarnings: checklist.warnings,
    });
    await cancel(s, saleA);

    const allocation = await renderWith(s, PERMS_MANAGER);
    const shares = allocation!.vehicles.find((v) => v.vehicleId === s.vehicleA)!.awaitingDecision;
    expect(shares.every((share) => share.status === "REVERSING")).toBe(true);

    expect(screen.getAllByText("DepositReversingPending").length).toBe(shares.length);
    expect(screen.queryAllByText("DepositRecordDecision")).toHaveLength(0);
  });
});

describe("what each role can do with a released share", () => {
  async function releasedShareFor(tag: string) {
    const s = await seedQuote(tag);
    await payDeposit(s, 5_000);
    await allocate(s, [
      { vehicleId: s.vehicleA, amount: 3_000 },
      { vehicleId: s.vehicleB, amount: 2_000 },
    ]);
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      vehicleId: s.vehicleA,
    });
    return s;
  }

  test("SALES sees the share but cannot refund or forfeit it", async () => {
    // The bar is the server's: refund and forfeiture need approval, and
    // `payOutDepositSlice` additionally refuses whoever took the deposit.
    // Surfacing that as a rejected click is worse than not offering it.
    const s = await releasedShareFor("salesRole");
    await renderWith(s, PERMS_SALES);

    const [record] = screen.getAllByText("DepositRecordDecision");
    const button = record.closest("button") as HTMLButtonElement;
    // The default treatment moves no money, so it is actionable.
    expect(button.disabled).toBe(false);
    expect(screen.queryAllByText("DepositDecisionNeedsApproval")).toHaveLength(0);

    const row = record.closest("div.space-y-2") as HTMLElement;
    chooseTreatment(row, "DepositTreatmentRefund");

    expect((screen.getAllByText("DepositRecordDecision")[0]!.closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("DepositDecisionNeedsApproval").length).toBeGreaterThan(0);
    expect(mutationCalls).toHaveLength(0);
  });

  test("SALES can still return a share to the deal, which moves no money", async () => {
    const s = await releasedShareFor("salesReturn");
    const allocation = await renderWith(s, PERMS_SALES);
    const holdId = allocation!.vehicles.find((v) => v.vehicleId === s.vehicleA)!
      .awaitingDecision[0]!.holdId;

    fireEvent.click(screen.getAllByText("DepositRecordDecision")[0]!.closest("button")!);

    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]!.args).toMatchObject({
      holdId,
      treatment: "RETURN_TO_UNALLOCATED",
    });
  });

  test("MANAGER can record the decision, and it reaches the server as chosen", async () => {
    const s = await releasedShareFor("managerRole");
    const allocation = await renderWith(s, PERMS_MANAGER);
    const holdId = allocation!.vehicles.find((v) => v.vehicleId === s.vehicleA)!
      .awaitingDecision[0]!.holdId;

    const [record] = screen.getAllByText("DepositRecordDecision");
    fireEvent.click(record.closest("button")!);

    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]!.args).toMatchObject({
      orgId: s.orgId,
      holdId,
      treatment: "RETURN_TO_UNALLOCATED",
    });
  });

  test("an irreversible decision is confirmed before it is sent", async () => {
    const s = await releasedShareFor("confirmRole");
    await renderWith(s, PERMS_MANAGER);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    const row = screen
      .getAllByText("DepositRecordDecision")[0]!
      .closest("div.space-y-2") as HTMLElement;
    chooseTreatment(row, "DepositTreatmentForfeit");

    fireEvent.click(screen.getAllByText("DepositRecordDecision")[0]!.closest("button")!);

    expect(confirm).toHaveBeenCalled();
    expect(mutationCalls).toHaveLength(0);
  });

  test("and goes through once the confirmation is accepted", async () => {
    const s = await releasedShareFor("confirmAccepted");
    const allocation = await renderWith(s, PERMS_MANAGER);
    const holdId = allocation!.vehicles.find((v) => v.vehicleId === s.vehicleA)!
      .awaitingDecision[0]!.holdId;
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const row = screen
      .getAllByText("DepositRecordDecision")[0]!
      .closest("div.space-y-2") as HTMLElement;
    chooseTreatment(row, "DepositTreatmentForfeit");
    fireEvent.click(screen.getAllByText("DepositRecordDecision")[0]!.closest("button")!);

    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]!.args).toMatchObject({ holdId, treatment: "FORFEITED" });
  });
});

describe("the role that cannot reach this screen at all", () => {
  test("RECEPTION is refused by the query the screen depends on", async () => {
    // The crash this prevents: the customer dialog is reachable with
    // VIEW_CUSTOMERS alone, `quoteAllocation` requires VIEW_SALES and THROWS
    // rather than returning null, and convex/react rethrows a query error
    // during render — so mounting it unconditionally replaced the whole page
    // with the error boundary for that role, on every customer.
    const s = await seedQuote("receptionRole", PERMS_RECEPTION);
    await payDeposit(s, 5_000);

    await expect(
      s.asViewer.query(api.deposits.quoteAllocation, {
        orgId: s.orgId,
        quoteId: s.quoteId,
      })
    ).rejects.toThrow(/permission/i);

    // And the same caller can still read the customer, which is why the two
    // must not be mounted together without a gate.
    await expect(
      s.asViewer.query(api.customers.getRelations, {
        orgId: s.orgId,
        customerId: s.customerId,
      })
    ).resolves.toBeDefined();
  });

  test("the mount is gated on the permission the query requires", () => {
    // Asserted against the source because rendering the whole customer dialog
    // would prove less: it is the gate that matters, and it is one condition.
    const dialog = readFileSync(
      join(process.cwd(), "components/customers/CustomerDetailsDialog.tsx"),
      "utf8"
    );
    expect(dialog).toContain("canViewSales");
    expect(dialog).toMatch(/canViewSales\s*&&\s*\(\s*\n?\s*<QuoteDepositManager|canViewSales && \(/);
    expect(dialog).toContain("PERMISSIONS.VIEW_SALES");
  });
});
