import { AuthConfig } from "convex/server";
import { getAuthConfigEnv } from "./utils/env";

const env = getAuthConfigEnv();

export default {
  providers: [
    {
      domain: env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;