import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { projectSaleRow } from "./saleRowProjection";
import { ConvexError } from "convex/values";

export async function readVehicleRelations(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
  role: Doc<"roles">,
) {
  // 1. Fetch Sales (a vehicle has at most a handful of sales)
  // Soft-deleted rows are excluded from all three lists below: this is the
  // vehicle's live relations panel, and a deleted sale, lead or expense
  // reappearing there is the same leak `isDeleted` exists to prevent.
  const sales = await ctx.db
    .query("sales")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .filter((q) => q.and(
      q.eq(q.field("vehicleId"), args.vehicleId),
      q.neq(q.field("isDeleted"), true)
    ))
    .take(20);

  const enrichedSales = await Promise.all(
    sales.map(async (sale) => {
      const customer = await ctx.db.get(sale.customerId);
      const salesperson = await ctx.db.get(sale.salespersonId);
      return {
        ...projectSaleRow(sale, role),
        customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
        salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
      };
    })
  );

  // 2. Fetch Leads
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .filter((q) => q.and(
      q.eq(q.field("vehicleId"), args.vehicleId),
      q.neq(q.field("isDeleted"), true)
    ))
    .take(50);

  const enrichedLeads = await Promise.all(
    leads.map(async (lead) => {
      const customer = await ctx.db.get(lead.customerId);
      const assignedUser = lead.assignedUserId ? await ctx.db.get(lead.assignedUserId) : null;
      return {
        ...lead,
        customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
        assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unassigned",
      };
    })
  );

  // 3. Fetch Expenses
  const expenses = await ctx.db
    .query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .filter((q) => q.neq(q.field("isDeleted"), true))
    .take(200);

  const enrichedExpenses = await Promise.all(
    expenses.map(async (exp) => {
      const payer = exp.payerId ? await ctx.db.get(exp.payerId) : null;
      return {
        ...exp,
        payerName: payer && "name" in payer ? payer.name : null,
        status: exp.status || "PAID",
      };
    })
  );

  // 4. Fetch Tasks
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .take(200);

  const enrichedTasks = await Promise.all(
    tasks.map(async (task) => {
      const assignedUser = await ctx.db.get(task.assignedTo);
      return {
        ...task,
        assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unknown",
      };
    })
  );

  // 5. Fetch Test Drives
  const testDrives = await ctx.db
    .query("test_drives")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .collect();

  const enrichedTestDrives = await Promise.all(
    testDrives.map(async (td) => {
      const customer = await ctx.db.get(td.customerId);
      const salesperson = await ctx.db.get(td.salespersonId);
      return {
        ...td,
        customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
        salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
      };
    })
  );

  // 6. Fetch Work Orders
  const workOrders = await ctx.db
    .query("workOrders")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .collect();

  return {
    sales: enrichedSales.sort((a, b) => b.saleDate - a.saleDate),
    leads: enrichedLeads.sort((a, b) => b._creationTime - a._creationTime),
    expenses: enrichedExpenses.sort((a, b) => b.date - a.date),
    tasks: enrichedTasks.sort((a, b) => a.dueDate - b.dueDate),
    testDrives: enrichedTestDrives.sort((a, b) => b.startTime - a.startTime),
    workOrders: workOrders.sort((a, b) => b._creationTime - a._creationTime),
  };
}

export async function readVehicleReservationHistory(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
) {

  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  const reservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .order("desc")
    .take(100);

  const reservationRows = await Promise.all(
    reservations.map(async (reservation) => {
      const customer = await ctx.db.get(reservation.customerId);
      const reservedBy = await ctx.db.get(reservation.reservedBy);
      const releasedBy = reservation.releasedBy ? await ctx.db.get(reservation.releasedBy) : null;
      return {
        ...reservation,
        origin: "RESERVATION" as const,
        customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
        reservedByName: reservedBy?.name ?? reservedBy?.email ?? null,
        releasedByName: releasedBy?.name ?? releasedBy?.email ?? null,
      };
    })
  );

  // A deposit taken in the sales wizard holds the vehicle just as hard as a
  // reservation does, but writes only a `deposits` row — so this tab used to
  // read "No reservations recorded" while a live hold was keeping the car off
  // the market. Deposits that were created *by* a reservation are skipped:
  // the reservation row above already represents them.
  const heldDeposits = await ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", args.vehicleId))
    .order("desc")
    .take(100);

  // A vehicle can also be a *secondary* line on a multi-vehicle quote, whose
  // deposit row only ever snapshots the primary vehicleId — the join table is
  // the sole record. Without this, the second and third cars on a three-car
  // deal showed "No reservations recorded" while genuinely being held.
  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", args.vehicleId))
    .take(100);
  const secondaryDeposits = await Promise.all(
    secondaryHolds.map(async (hold) => {
      const deposit = await ctx.db.get(hold.depositId);
      return deposit ? { deposit, joinActive: hold.active } : null;
    })
  );

  const candidateDeposits = [
    ...heldDeposits.map((deposit) => ({ deposit, joinActive: null as boolean | null })),
    ...secondaryDeposits.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  ];

  const seenDepositIds = new Set<string>();
  const depositRows = await Promise.all(
    candidateDeposits
      .filter(({ deposit }) => {
        if (
          deposit.orgId !== args.orgId ||
          deposit.reservationId !== undefined ||
          deposit.isDeleted === true
        ) {
          return false;
        }
        if (seenDepositIds.has(deposit._id)) return false;
        seenDepositIds.add(deposit._id);
        return true;
      })
      .map(async ({ deposit, joinActive }) => {
        const [customer, reservedBy, releasedBy] = await Promise.all([
          ctx.db.get(deposit.customerId),
          ctx.db.get(deposit.createdBy),
          deposit.resolvedBy ? ctx.db.get(deposit.resolvedBy) : Promise.resolve(null),
        ]);
        // ACTIVE is driven by `holdActive`, not by `status`. The two are
        // deliberately decoupled (see the deposits table in schema.ts): a
        // rejected finance application, a released reservation and an expired
        // reservation all clear holdActive while leaving the deposit HELD so a
        // manager still decides refund vs forfeit. Reading `status` alone
        // rendered those as ACTIVE holds forever, with a live Release button,
        // long after they stopped holding anything.
        const stillHolding =
          deposit.status === "HELD" && deposit.holdActive === true && joinActive !== false;
        const status = stillHolding
          ? ("ACTIVE" as const)
          : deposit.status === "APPLIED"
            ? ("CONVERTED" as const)
            : ("RELEASED" as const);
        return {
          _id: deposit._id,
          _creationTime: deposit._creationTime,
          origin: "DEPOSIT" as const,
          // A forfeited deposit means the dealership kept the money — a
          // materially different outcome from a refund, and the tab used to
          // render both identically.
          depositResolution: deposit.status,
          orgId: deposit.orgId,
          vehicleId: deposit.vehicleId,
          customerId: deposit.customerId,
          status,
          depositAmount: deposit.amount,
          expiresAt: undefined as number | undefined,
          reservedAt: deposit.createdAt ?? deposit._creationTime,
          releasedAt: deposit.resolvedAt,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
          reservedByName: reservedBy?.name ?? reservedBy?.email ?? null,
          releasedByName: releasedBy?.name ?? releasedBy?.email ?? null,
        };
      })
  );

  return [...reservationRows, ...depositRows]
    .sort((a, b) => b.reservedAt - a.reservedAt)
    .slice(0, 100);
}

export async function readVehiclePricingHistory(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
) {

  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  return await ctx.db
    .query("vehiclePriceHistory")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .order("desc")
    .take(100);
}
