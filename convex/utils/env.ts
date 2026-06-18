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
});

export function getValidatedEnv() {
  const result = backendEnvSchema.safeParse({
    CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    SUPER_ADMIN_EMAILS: process.env.SUPER_ADMIN_EMAILS,
  });
  
  if (!result.success) {
    const errorMsg = "Backend Environment Variables Missing/Invalid: " +
      result.error.errors.map(e => `${e.path.join('.')}`).join(', ');
    throw new ConvexError(errorMsg);
  }
  
  return result.data;
}
