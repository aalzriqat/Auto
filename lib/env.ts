import { z } from "zod";

const envSchema = z.object({
  // Next.js client-side variables (must start with NEXT_PUBLIC_)
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1).optional(),
  
  // Next.js server-side variables
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  SENTRY_DSN: z.string().min(1).optional(),
});

/**
 * Validate the environment variables.
 * In Next.js, process.env is evaluated at build time for NEXT_PUBLIC_ variables,
 * so we can safely validate them here.
 */
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:", _env.error.format());
  throw new Error("Invalid environment variables");
}

export const env = _env.data;
