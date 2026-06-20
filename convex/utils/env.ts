import { ConvexError } from "convex/values";
import { z } from "zod";

const backendEnvSchema = z.object({
  // Require these for the application to function
  CLERK_JWT_ISSUER_DOMAIN: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  
  // Optional but recommended
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  CLERK_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  RESEND_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),

  // Comma-separated list of emails allowed into the /admin super-admin dashboard
  SUPER_ADMIN_EMAILS: z.string().optional(),

  // Instagram/Facebook OAuth (Meta App) — optional, only needed for the
  // social posting integration (Settings > Integrations)
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  // Auto-injected by Convex at runtime; validated here so a missing value
  // fails loudly instead of producing a broken OAuth redirect URI.
  CONVEX_SITE_URL: z.string().url().optional(),
});

export function getValidatedEnv() {
  const result = backendEnvSchema.safeParse({
    CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    SUPER_ADMIN_EMAILS: process.env.SUPER_ADMIN_EMAILS,
    INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID,
    INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  });
  
  if (!result.success) {
    const errorMsg = "Backend Environment Variables Missing/Invalid: " +
      result.error.errors.map(e => `${e.path.join('.')}`).join(', ');
    throw new ConvexError(errorMsg);
  }
  
  return result.data;
}
