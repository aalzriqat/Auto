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

  // Facebook Login for Pages — kept as a separate Meta App from Instagram's
  // (the Instagram app is configured specifically for "API setup with
  // Instagram Login"; Facebook Login may or may not coexist as a second
  // product on it, unconfirmed) — so these are independent env vars.
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  // Meta App Secret used to verify the `X-Hub-Signature-256` header Meta
  // sends on every WhatsApp Cloud API webhook POST — required before the
  // /whatsapp-webhook route will accept inbound messages.
  WHATSAPP_APP_SECRET: z.string().optional(),

  // Verify token for the Instagram webhook (comments + DMs) handshake. Meta
  // only allows one webhook callback URL per App, so this is a single
  // app-level secret, not per-org like WHATSAPP_WEBHOOK_SECRET. Signature
  // verification on the POST body reuses INSTAGRAM_APP_SECRET.
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  // Optional secret used only by the protected Convex load-test health probe.
  LOAD_TEST_SECRET: z.string().min(16).optional(),
  // Deprecated legacy shared secret for the old generic payment-provider
  // webhook. Provider-native webhook verifiers below are now used for
  // settlement instead.
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Provider-native payment webhook secrets. Stripe signs the raw request body
  // with the endpoint secret. Tap signs a normalized hashstring using the
  // merchant Secret API Key.
  STRIPE_WEBHOOK_SECRET: z.string().min(16).optional(),
  TAP_SECRET_API_KEY: z.string().min(16).optional(),
  // Cloudflare Turnstile secret for public dealer-site lead forms. The public
  // action fails closed when this is absent.
  TURNSTILE_SECRET_KEY: z.string().min(20).optional(),
  // Domain registrar mode. Defaults to disabled; set to "mock" only for local
  // development/tests until a real registrar/payment/reconciliation workflow
  // exists.
  DOMAIN_REGISTRAR_MODE: z.enum(["disabled", "mock"]).optional(),
  // Auto-injected by Convex at runtime; validated here so a missing value
  // fails loudly instead of producing a broken OAuth redirect URI.
  CONVEX_SITE_URL: z.string().url().optional(),

  // Web Push (VAPID) keypair for sendNotificationPush (convex/pushSend.ts).
  // Optional like RESEND_API_KEY: push sends quietly no-op until generated
  // via `npx web-push generate-vapid-keys` and set on the deployment.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // Contact URI required by the Web Push protocol (mailto: or https:) so
  // push services can reach the sender about problems with a subscription.
  VAPID_SUBJECT: z.string().optional(),
});

// auth.config.ts is special: Convex statically scans every process.env
// reference reachable from it and requires each one to be set in the
// deployment's dashboard before ANY function (not just auth) will deploy —
// it ignores .optional() in the schema above. Routing auth.config.ts through
// the full getValidatedEnv() meant an unset, unrelated integration secret
// (e.g. WHATSAPP_APP_SECRET) could take down the entire backend. This
// validates only what auth bootstrapping actually needs.
const authConfigEnvSchema = z.object({
  CLERK_JWT_ISSUER_DOMAIN: z.string().url(),
});

export function getAuthConfigEnv() {
  const result = authConfigEnvSchema.safeParse({
    CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
  });

  if (!result.success) {
    const errorMsg = "Auth Environment Variable Missing/Invalid: " +
      result.error.errors.map(e => e.path.join('.')).join(', ');
    throw new ConvexError(errorMsg);
  }

  return result.data;
}

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
    FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
    FACEBOOK_WEBHOOK_VERIFY_TOKEN: process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
    LOAD_TEST_SECRET: process.env.LOAD_TEST_SECRET,
    PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    TAP_SECRET_API_KEY: process.env.TAP_SECRET_API_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    DOMAIN_REGISTRAR_MODE: process.env.DOMAIN_REGISTRAR_MODE,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  });
  
  if (!result.success) {
    const errorMsg = "Backend Environment Variables Missing/Invalid: " +
      result.error.errors.map(e => `${e.path.join('.')}`).join(', ');
    throw new ConvexError(errorMsg);
  }
  
  return result.data;
}
