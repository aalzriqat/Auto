import { describe, expect, it } from "vitest";
import { REPLAY_MAX_LIFETIME_MS, REPLAY_NONCE_MIN_LENGTH as SERVER_NONCE_MIN, REPLAY_RUN_ID_PATTERN as SERVER_RUN_ID, replayProofFor } from "../../convex/e2eBootstrap";
import { REPLAY_MAX_ORG_AGE_MS, REPLAY_NONCE_MIN_LENGTH as CLIENT_NONCE_MIN, REPLAY_RUN_ID_PATTERN as CLIENT_RUN_ID } from "./replayIsolation";
import { replayProof } from "./replayProof";

const NONCE = "0123456789abcdef0123456789abcdef";

describe("replayProof (client) and replayProofFor (server) agree", () => {
  it.each([
    [NONCE, "org_abc123", "run-1"],
    ["fedcba9876543210fedcba9876543210", "k57x9y", "1234567890"],
    ["a".repeat(64), "o", "r"],
  ])("same proof for %#", (nonce, orgId, runId) => {
    expect(replayProof(nonce, orgId, runId)).toBe(replayProofFor(nonce, orgId, runId));
    expect(replayProof(nonce, orgId, runId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the organization, the run and the nonce, and does not contain the nonce", () => {
    const base = replayProof(NONCE, "org1", "run1");
    expect(replayProof(NONCE, "org2", "run1")).not.toBe(base);
    expect(replayProof(NONCE, "org1", "run2")).not.toBe(base);
    expect(replayProof("fedcba9876543210fedcba9876543210", "org1", "run1")).not.toBe(base);
    expect(base).not.toContain(NONCE);
  });
});

describe("client and server agree on the shared limits", () => {
  it("pins the nonce minimum, the run id pattern and the 2 hour cap", () => {
    expect(CLIENT_NONCE_MIN).toBe(SERVER_NONCE_MIN);
    expect(CLIENT_NONCE_MIN).toBe(32);
    expect(CLIENT_RUN_ID.source).toBe(SERVER_RUN_ID.source);
    expect(CLIENT_RUN_ID.flags).toBe(SERVER_RUN_ID.flags);
    expect(REPLAY_MAX_ORG_AGE_MS).toBe(REPLAY_MAX_LIFETIME_MS);
    expect(REPLAY_MAX_LIFETIME_MS).toBe(2 * 60 * 60 * 1000);
  });
});
