import { AuthConfig } from "convex/server";
import { getAuthConfigEnv } from "./utils/env";

const env = getAuthConfigEnv();

// CLERK_DEV_JWT_ISSUER_DOMAIN is usually the same value as
// CLERK_JWT_ISSUER_DOMAIN (a harmless duplicate) — see convex/utils/env.ts.
// On deployments where it differs (e.g. pointing at Clerk's development
// instance), this second entry lets that instance's sessions authenticate
// too, without weakening trust in the primary issuer.
export default {
  providers: [
    {
      domain: env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    {
      domain: env.CLERK_DEV_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;