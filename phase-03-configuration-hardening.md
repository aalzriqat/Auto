# Phase 3 — Configuration & Environment Hardening

**Estimated effort:** 1 developer × 1 day
**Prerequisites:** None
**Risk level:** Low
**Rollback strategy:** Revert `convex/utils/env.ts` and remove validation calls from the backend functions.

## Objective
The application currently fails silently or unpredictably at runtime if backend environment variables (like `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL` in the backend, or `CLERK_WEBHOOK_SECRET`) are missing. We need a fail-fast mechanism on the backend similar to the frontend's `lib/env.ts`.

## Step-by-Step Instructions

### 1. Create Backend Environment Validator
1. Create a new file `convex/utils/env.ts`.
2. Write a Zod schema to validate all required backend environment variables.
   *(Note: Convex exposes environment variables via `process.env` in action handlers, but for query/mutation handlers they are accessed via `process.env` as well).*

```typescript
import { z } from "zod";

const backendEnvSchema = z.object({
  // Require these for the application to function
  CLERK_JWT_ISSUER_DOMAIN: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  
  // Optional but recommended
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  CLERK_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
});

export function getValidatedEnv() {
  const result = backendEnvSchema.safeParse(process.env);
  
  if (!result.success) {
    const errorMsg = "Backend Environment Variables Missing/Invalid: " + 
      result.error.errors.map(e => `${e.path.join('.')}`).join(', ');
    console.error(errorMsg);
    throw new Error(errorMsg); // This will crash the action/mutation predictably
  }
  
  return result.data;
}
```

### 2. Implement the Validator in Critical Paths
1. Open `convex/email.ts`.
2. Replace direct `process.env.RESEND_API_KEY` accesses with the validator:

```typescript
import { getValidatedEnv } from "./utils/env";

export const sendTeamInvite = internalAction({
  // ...
  handler: async (ctx, args) => {
    const env = getValidatedEnv();
    
    // Now you safely have env.NEXT_PUBLIC_APP_URL without manual null checks
    const inviteUrl = `${env.NEXT_PUBLIC_APP_URL}/sign-up`;
    
    if (!env.RESEND_API_KEY) {
      console.log(`[MOCK EMAIL] To: ${args.toEmail}`);
      return { success: true, mock: true };
    }
    // ...
  }
});
```

3. Open `convex/http.ts` (the webhook handler).
4. Implement the validator at the start of the `clerk-webhook` handler to ensure it fails fast with a clear error if the secret is missing.

### 3. Frontend Env File Cleanup
1. Ensure `.env.local` is listed in `.gitignore` (it appears to be `.*env*`, verify this).
2. Create an `.env.example` file in the root of the project.
3. Document all required environment variables in `.env.example` with blank or dummy values so new developers know exactly what to provision.

## Definition of Done
- [ ] `convex/utils/env.ts` is created and exports `getValidatedEnv`.
- [ ] `email.ts`, `http.ts`, and `auth.config.ts` use the validated environment config.
- [ ] `.env.example` exists and documents all variables found in `.env.local`.

## How to Test This Phase
1. Temporarily comment out `NEXT_PUBLIC_APP_URL` in your `.env.local` and restart the dev server.
2. Attempt to trigger a team invite from the UI.
3. Ensure the Convex backend logs immediately output "Backend Environment Variables Missing/Invalid: NEXT_PUBLIC_APP_URL" instead of failing deeper in the string concatenation logic.
4. Restore the variable and verify it works.
