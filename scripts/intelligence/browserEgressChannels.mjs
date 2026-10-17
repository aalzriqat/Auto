/**
 * The mandatory egress probes (SCRUM-350 G4R2-02), single source of truth.
 *
 * browserEgressProof.mjs attempts exactly these channels (a test pins the two
 * together) and browserEgressProofVerify.mjs requires every one of them, with
 * an outcome from the list below, before a verdict can rely on the proof. The
 * outcomes are the browser-side reports of an attack that the proxy refused;
 * an escape ("open", "REGISTERED", a 2xx navigation) or an unavailable probe
 * ("unavailable") is deliberately not listed, so it can never pass.
 */
export const EGRESS_PROOF_CHANNELS = Object.freeze({
  fetch: ["opaque", "threw:TypeError"],
  "fetch-keepalive": ["opaque", "threw:TypeError"],
  "fetch-https": ["opaque", "threw:TypeError"],
  "fetch-unknown-name": ["opaque", "threw:TypeError"],
  xhr: ["done"],
  image: ["done"],
  beacon: ["true", "false"],
  websocket: ["error", "close", "timeout"],
  eventsource: ["error", "timeout"],
  iframe: ["done", "timeout"],
  "form-post": ["submitted"],
  popup: ["true", "false"],
  webrtc: ["attempted"],
  "service-worker": ["blocked"],
});

/** A top-level navigation to the collector must be refused by the proxy. */
export const EGRESS_PROOF_NAVIGATION_OUTCOMES = Object.freeze(["response:403", "failed"]);
