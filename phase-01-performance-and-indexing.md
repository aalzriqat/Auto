# Phase 1 — Critical Performance & Indexing

**Estimated effort:** 1 developer × 4 days
**Prerequisites:** None
**Risk level:** High (involves changing core reporting queries and database schema indices)
**Rollback strategy:** Revert `convex/schema.ts` and `convex/reports.ts` to the previous commit.

## Objective
Eliminate severe N+1 query patterns that cause `reports.ts` to time out and consume excessive memory. Eliminate the full table scan in the `triggerAlarms` cron job.

## Step-by-Step Instructions

### 1. Fix the Cron Job Full Table Scan
The `triggerAlarms` cron job in `convex/crons.ts` currently performs a full table scan across all organizations because it filters by `status` and `alarmTriggered` in memory (or without a proper index).

1. **Update `convex/schema.ts`:**
   Navigate to the `tasks` table definition (around line 253).
   Add a new index specifically for the cron job:
   ```typescript
   // Add this to the end of the tasks defineTable chain
   .index("by_status_alarm", ["status", "alarmTriggered"])
   ```

2. **Update `convex/crons.ts`:**
   Navigate to the `triggerAlarms` mutation (around line 32).
   Replace the unbounded query:
   ```typescript
   const allPendingTasks = await ctx.db
     .query("tasks")
     .filter((q) => q.eq(q.field("status"), "PENDING"))
     .filter((q) => q.neq(q.field("alarmTriggered"), true))
     .collect();
   ```
   With an indexed query:
   ```typescript
   const allPendingTasks = await ctx.db
     .query("tasks")
     .withIndex("by_status_alarm", (q) => 
       q.eq("status", "PENDING").eq("alarmTriggered", undefined)
     )
     .collect();
   ```
   *(Note: Ensure boolean `false` and `undefined` states are handled correctly based on your schema design).*

### 2. Fix N+1 Queries in `convex/reports.ts`
The `getSalesAndProfitReport` query fetches all sales, loops through them, and executes `ctx.db.get()` and `ctx.db.query("expenses")...` for every single sale.

1. **Update `getSalesAndProfitReport` in `convex/reports.ts`:**
   - Instead of fetching expenses inside the `.map()`, fetch all relevant expenses for the organization within the date range *first*.
   - Fetch all vehicles for the organization *first*.
   - Create lookup maps in memory.

   **Before:**
   ```typescript
   const enrichedSales = await Promise.all(
     salesInDateRange.map(async (sale) => {
       const vehicle = await ctx.db.get(sale.vehicleId);
       const expenses = await ctx.db
         .query("expenses")
         .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", sale.vehicleId))
         .collect();
       // ...
   ```

   **After:**
   ```typescript
   // 1. Bulk fetch related vehicles
   const vehicleIds = Array.from(new Set(salesInDateRange.map(s => s.vehicleId)));
   const vehicles = await Promise.all(vehicleIds.map(id => ctx.db.get(id)));
   const vehicleMap = new Map(vehicles.filter(Boolean).map(v => [v._id, v]));

   // 2. Bulk fetch all expenses for the org (or specifically for these vehicles if possible)
   const allOrgExpenses = await ctx.db
     .query("expenses")
     .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
     .collect();
     
   // Group expenses by vehicleId
   const expensesByVehicle = new Map<string, typeof allOrgExpenses>();
   for (const exp of allOrgExpenses) {
     if (!exp.vehicleId) continue;
     const existing = expensesByVehicle.get(exp.vehicleId) || [];
     existing.push(exp);
     expensesByVehicle.set(exp.vehicleId, existing);
   }

   // 3. Process synchronously without db calls
   const enrichedSales = salesInDateRange.map((sale) => {
     const vehicle = vehicleMap.get(sale.vehicleId);
     const expenses = expensesByVehicle.get(sale.vehicleId) || [];
     // ... calculate totals as before
   });
   ```

2. **Repeat for `getInventoryReport` and `getSalespersonPerformance`:**
   Apply the exact same "Bulk Fetch -> In-Memory Map -> Synchronous Map" pattern to eliminate all database reads from inside the `.map()` loops.

## Definition of Done
- [ ] New index `by_status_alarm` is defined in `schema.ts`.
- [ ] `crons.ts` uses the new index for fetching pending tasks.
- [ ] `reports.ts` contains zero `await ctx.db.*` calls inside `Array.map` or `for` loops.
- [ ] All reports render correctly in the dashboard with identical mathematical results.

## How to Test This Phase
1. Seed the database with 1,000+ sales and expenses (using a local script).
2. Open the "Reports" tab in the dashboard.
3. Observe the Convex dashboard logs: there should only be 3-4 query executions per report load, down from 1,000+.
4. Ensure the Profit calculations exactly match the pre-refactor numbers.
