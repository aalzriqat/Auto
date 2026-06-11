# Phase 2 — Input Validation Layer

**Estimated effort:** 1 developer × 3 days
**Prerequisites:** None
**Risk level:** Medium (requires matching Zod schemas to database schemas strictly)
**Rollback strategy:** Revert changes to Convex endpoint handlers and remove `zod` wrappers.

## Objective
The current Convex backend heavily relies on basic type checking (`v.string()`, `v.number()`). We need business-logic validation to prevent corrupted data from entering the database (e.g., negative prices, excessively long strings, malformed email addresses).

## Step-by-Step Instructions

### 1. Create a Central Validation Library
1. Ensure `zod` is installed in the project (it should be in `package.json`).
2. Create a new directory `convex/validations/`.
3. Create `convex/validations/sales.ts`.
4. Define Zod schemas that mirror the Convex arguments but add strict business constraints.

```typescript
import { z } from "zod";

export const CreateSaleSchema = z.object({
  salePrice: z.number().positive("Sale price must be greater than zero"),
  downPayment: z.number().min(0, "Down payment cannot be negative").optional(),
  termMonths: z.number().min(1).max(120, "Term cannot exceed 120 months").optional(),
  apr: z.number().min(0).max(100, "APR must be between 0 and 100").optional(),
  // Add other fields...
}).refine(data => {
  if (data.downPayment && data.downPayment >= data.salePrice) {
    return false;
  }
  return true;
}, {
  message: "Down payment cannot exceed or equal the sale price",
  path: ["downPayment"]
});
```

### 2. Implement a Validation Middleware/Helper
Create `convex/utils/validation.ts`:

```typescript
import { ConvexError } from "convex/values";
import { z } from "zod";

export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    // Format the error nicely for the client
    const errorMessage = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ConvexError(`Validation failed: ${errorMessage}`);
  }
  return result.data;
}
```

### 3. Integrate Validation into Mutations
1. Open `convex/sales.ts`.
2. In the `create` mutation handler, immediately after rate limiting, validate the arguments:

```typescript
import { validateInput } from "./utils/validation";
import { CreateSaleSchema } from "./validations/sales";

export const create = mutation({
  args: { /* standard Convex args */ },
  handler: async (ctx, args) => {
    // 1. Rate Limiting
    // 2. Auth checking
    // 3. Business Validation
    const validatedData = validateInput(CreateSaleSchema, args);

    // Proceed with database writes using validatedData...
  }
});
```

3. Repeat this process for:
   - `convex/vehicles.ts` (validate VIN length, realistic mileage, positive prices)
   - `convex/customers.ts` (validate email format, phone number regex)
   - `convex/expenses.ts` (validate amount > 0)

## Definition of Done
- [ ] Central `validation.ts` utility is created.
- [ ] Zod schemas exist for Vehicles, Customers, Sales, and Expenses.
- [ ] The `create` and `update` mutations for the above domains actively call `validateInput`.
- [ ] Passing invalid data (e.g., negative sale price) throws a `ConvexError` with a readable error string that the UI can catch and display via `toast.error()`.

## How to Test This Phase
1. Use the UI to attempt to create a vehicle with a negative purchase price. The UI should show an error toast.
2. Intercept the network request (or use the Convex dashboard) to send a direct mutation to `sales.create` with a `downPayment` higher than the `salePrice`. It must fail with `Validation failed`.
3. Check the Convex dashboard logs to ensure the error is handled gracefully.
