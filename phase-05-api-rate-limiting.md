# Phase 5 — API Rate Limiting & DoS Protection

**Estimated effort:** 1 developer × 2 days
**Prerequisites:** None
**Risk level:** Medium (setting rates too low will block legitimate dealership usage)
**Rollback strategy:** Remove the rate limit checks from the affected backend endpoints.

## Objective
The `@convex-dev/rate-limiter` is currently only used for `email`, `create` (sales), and `upload` (documents). A malicious user or aggressive web scraper could repeatedly call expensive endpoints (like the N+1 `reports.ts` queries) or bulk-fetch inventory, exhausting the organization's database bandwidth and potentially taking the application offline.

## Step-by-Step Instructions

### 1. Define New Rate Limit Categories
Open `convex/rateLimit.ts` and expand the configuration. Note that these capacities should be high enough not to block a fast-clicking legitimate user, but low enough to block a script looping `fetch`.

```typescript
import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Existing
  email: { kind: "token bucket", rate: 5, period: 60000, capacity: 5 },
  create: { kind: "token bucket", rate: 30, period: 60000, capacity: 30 },
  upload: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 },
  
  // New Categories
  heavyRead: { kind: "token bucket", rate: 20, period: 60000, capacity: 20 }, // For reports and massive aggregations
  standardApi: { kind: "token bucket", rate: 100, period: 60000, capacity: 200 }, // General mutations (updates, deletes)
});
```

### 2. Apply Rate Limits to Expensive Read Queries
1. Open `convex/reports.ts`.
2. Inside every exported query (`getSalesAndProfitReport`, `getInventoryReport`, etc.), add a rate limit check immediately after tenant auth checking.

```typescript
import { rateLimiter } from "./rateLimit";
import { ConvexError } from "convex/values";

export const getSalesAndProfitReport = query({
  // ...
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_REPORTS]);
    
    // Apply rate limit
    const statusLimit = await rateLimiter.limit(ctx, "heavyRead", { key: args.orgId });
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded for reports. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }
    
    // ... rest of query
  }
});
```
*Note: Using `{ key: args.orgId }` ensures the limit is per-organization, so one aggressive dealership doesn't block another.*

### 3. Apply Rate Limits to Other Mutations
1. Open files containing mutations that delete or heavily update records (e.g., `convex/vehicles.ts`, `convex/sales.ts`).
2. Add the `standardApi` rate limiter to `update` and `softDelete` methods using the exact same pattern.

## Definition of Done
- [ ] `rateLimit.ts` is updated with `heavyRead` and `standardApi` buckets.
- [ ] All functions in `reports.ts` enforce the `heavyRead` limit.
- [ ] At least 5 critical `update` and `softDelete` endpoints enforce the `standardApi` limit.
- [ ] Hitting the limit returns a clean `ConvexError` that the frontend handles gracefully without crashing.

## How to Test This Phase
1. Set the `heavyRead` limit to an artificially low number temporarily (e.g., `capacity: 2`).
2. Open the frontend and rapidly click between the "Profit & Loss" and "Sales Report" tabs to trigger multiple query evaluations.
3. The third attempt should fail, and the UI should display a "Rate limit exceeded" error.
4. Wait 1 minute, and verify the UI recovers and loads the report again.
5. Revert the limit to the production values (`capacity: 20`).
