import { describe, expect, it } from "vitest";
import {
  decideOfflineSwarmClerk,
  OFFLINE_SWARM_CLERK_FLAG,
  OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
  offlineSwarmClerkOptions,
} from "./offlineSwarmClerk";

const PEM = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----";

const offlineEnv = {
  [OFFLINE_SWARM_CLERK_FLAG]: "1",
  CLERK_SECRET_KEY: OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ",
  CLERK_JWT_KEY: PEM,
};

describe("decideOfflineSwarmClerk", () => {
  it("is off, with unchanged middleware options, when the flag is absent even if CLERK_JWT_KEY is set", () => {
    // Production invariance: a real deployment may carry CLERK_JWT_KEY.
    for (const env of [
      { CLERK_JWT_KEY: PEM, CLERK_SECRET_KEY: "sk_live_real" },
      {
        CLERK_JWT_KEY: PEM,
        CLERK_SECRET_KEY: OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
      },
      { CLERK_JWT_KEY: PEM, [OFFLINE_SWARM_CLERK_FLAG]: "" },
      {},
    ]) {
      const decision = decideOfflineSwarmClerk(env);
      expect(decision).toEqual({ mode: "off" });
      expect(offlineSwarmClerkOptions(decision)).toEqual({});
    }
  });

  it("returns the jwtKey only when the flag and every condition hold", () => {
    const decision = decideOfflineSwarmClerk(offlineEnv);
    expect(decision).toEqual({ mode: "offline", jwtKey: PEM });
    expect(offlineSwarmClerkOptions(decision)).toEqual({ jwtKey: PEM });
  });

  it.each([
    ["a real secret key", { CLERK_SECRET_KEY: "sk_test_realish" }],
    ["a missing secret key", { CLERK_SECRET_KEY: undefined }],
    [
      "a placeholder with trailing whitespace",
      { CLERK_SECRET_KEY: `${OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET} ` },
    ],
    [
      "a live publishable key",
      { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Zm9v" },
    ],
    [
      "a missing publishable key",
      { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined },
    ],
    ["an empty jwt key", { CLERK_JWT_KEY: "" }],
    ["a blank jwt key", { CLERK_JWT_KEY: "  \n" }],
    ["a missing jwt key", { CLERK_JWT_KEY: undefined }],
    ["a flag that is not exactly 1", { [OFFLINE_SWARM_CLERK_FLAG]: "true" }],
    ["a flag of 0", { [OFFLINE_SWARM_CLERK_FLAG]: "0" }],
  ])("refuses (fail closed) with %s", (_label, override) => {
    const decision = decideOfflineSwarmClerk({ ...offlineEnv, ...override });
    expect(decision.mode).toBe("refused");
    // A refusal never yields a usable key.
    expect(offlineSwarmClerkOptions(decision)).toEqual({});
    if (decision.mode === "refused") {
      expect(decision.reasons.length).toBeGreaterThan(0);
      // Reasons name the failed condition but never echo a key value.
      expect(JSON.stringify(decision.reasons)).not.toContain(PEM);
    }
  });
});
