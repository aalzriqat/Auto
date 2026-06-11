import { AuthConfig } from "convex/server";
import { getValidatedEnv } from "./utils/env";

const env = getValidatedEnv();

export default {
  providers: [
    {
      domain: env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;