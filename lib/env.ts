import { z } from "zod";

const envSchema = z.object({
  // Next.js client-side variables (must start with NEXT_PUBLIC_)
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  // Base URL for this deployment's Convex httpActions (e.g. the /site-events
  // visitor-tracking beacon). Distinct from NEXT_PUBLIC_CONVEX_URL (the
  // reactive client endpoint, *.convex.cloud) — this one is *.convex.site.
  // Optional: visitor tracking silently no-ops (lib/analytics/payload.ts)
  // when unset, so it isn't a hard requirement to build/run the app.
  NEXT_PUBLIC_CONVEX_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  // The public base URL of this deployment (e.g. https://autoflowdealer.com/).
  // Used in server-side email links. Must be set in all non-local environments.
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1).optional(),
  // Public half of the VAPID keypair used by the client to subscribe to Web
  // Push (see convex/pushSend.ts). Optional — push subscribe UI stays hidden
  // until this and the server-side VAPID_PRIVATE_KEY are both set.
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().min(1).optional(),

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
