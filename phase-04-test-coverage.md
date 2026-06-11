# Phase 4 — Test Coverage Foundation

**Estimated effort:** 1 developer × 5 days
**Prerequisites:** None
**Risk level:** Low
**Rollback strategy:** N/A (adding tests does not affect production code, unless refactoring is required to make code testable).

## Objective
The application contains complex financial logic (deal structuring, APR math, profit calculation) and PDF layout generation that is currently untested. This phase establishes a testing foundation using the already-installed `vitest` and `convex-test` libraries.

## Step-by-Step Instructions

### 1. Setup Financial Logic Unit Tests
The file `lib/financing.ts` contains the core business math. It is pure TypeScript and can be unit tested directly.

1. Open (or create) `lib/financing.test.ts`.
2. Write comprehensive unit tests for `calculateDeal` covering:
   - Cash deals (no company ID)
   - Financed deals with varying APR/Profit rates
   - Deals exceeding maximum Loan-To-Value (LTV) rules
   - Edge cases (zero down payment, 1-month terms)

```typescript
import { expect, test, describe } from 'vitest';
import { calculateDeal } from './financing';

describe('Financing Engine', () => {
  test('should accurately calculate monthly installments for a standard financed deal', () => {
    // Arrange
    const params = {
      vehiclePrice: 10000,
      downPayment: 2000,
      termMonths: 60,
      profitRate: 5,
      // ...
    };
    
    // Act
    const result = calculateDeal(params);
    
    // Assert
    expect(result.totalFinancedAmount).toBe(8000); // Base example
    expect(result.monthlyInstallment).toBeCloseTo(166.67, 2);
  });
  
  test('should throw or return errors if LTV exceeds 85%', () => {
    // Write test here
  });
});
```

### 2. Setup Convex Backend Integration Tests
1. Set up `convex-test` to spin up local in-memory Convex environments for testing.
2. Create `convex/sales.test.ts`.
3. Write an integration test for the `create` sale mutation to verify the cross-domain side effects work properly.

```typescript
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

test("Creating a sale marks the vehicle as SOLD and creates a ledger transaction", async () => {
  const t = convexTest(schema);
  
  // Arrange: seed org, vehicle, customer, salesperson
  const orgId = await t.run(async (ctx) => {
    return await ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() });
  });
  
  // Act: run the create sale mutation
  const saleId = await t.mutation(api.sales.create, {
     orgId,
     // ... valid test params
  });
  
  // Assert
  await t.run(async (ctx) => {
     // Verify the vehicle status changed to SOLD
     const vehicle = await ctx.db.get(testVehicleId);
     expect(vehicle.status).toBe("SOLD");
     
     // Verify a transaction was created
     const tx = await ctx.db.query("transactions").first();
     expect(tx).not.toBeNull();
     expect(tx.amount).toBe(testSalePrice);
  });
});
```

### 3. Add Testing into the CI Pipeline
1. Create or update a GitHub Actions workflow `.github/workflows/test.yml`.
2. Ensure `npm run test` executes on every pull request to `main`.

## Definition of Done
- [ ] `lib/financing.test.ts` exists and passes with 90%+ coverage on calculation paths.
- [ ] `convex/sales.test.ts` exists and tests the successful creation and cancellation of a sale.
- [ ] `convex/utils/permissions.test.ts` exists to verify RBAC utility functions.
- [ ] Running `npm run test` completes without errors in under 30 seconds.

## How to Test This Phase
1. Run `npm run test` locally.
2. Introduce a deliberate math error in `lib/financing.ts` (e.g., change `+` to `-`).
3. Run `npm run test` and verify that the tests fail and catch the error.
