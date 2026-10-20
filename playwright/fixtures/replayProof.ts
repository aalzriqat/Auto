import { createHmac } from "node:crypto";

/**
 * The proof the replay sends to `e2eBootstrap.replayAttestation` instead of the run nonce: lower-case hex
 * HMAC-SHA256 keyed by the nonce over `${orgId}:${runId}`. Computed here with Node's own HMAC, deliberately NOT with
 * the backend's pure implementation, so the two are independent and a test can require that they agree.
 * The nonce is not sent, not returned and not printed; the proof binds one organization and one run.
 */
export function replayProof(nonce: string, orgId: string, runId: string): string {
  return createHmac("sha256", nonce).update(`${orgId}:${runId}`).digest("hex");
}
