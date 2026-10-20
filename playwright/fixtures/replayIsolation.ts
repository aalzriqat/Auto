// SCRUM-795: the isolation boundary of the accounting GL-register replay.
//
// The replay writes to the books: it may create or open an accounting period (which wakes held rows and
// schedules outbox work) and it posts an opening balance. That is only acceptable on a deployment that ITSELF
// attests it is a disposable preview, in an organization the trusted seed created on that deployment. This is an
// ALLOW-LIST: the positive attestation comes from the backend actually in use (`e2eBootstrap.replayAttestation`,
// read over the same connection the test uses), never from an operator-supplied name, and the production deny
// list below is only a second, independent refusal. Everything here is a pure function so a plain unit test can
// pin it; it imports nothing from the product.

/** Production deployments, refused even when everything else claims otherwise. Hand-written, never derived. */
export const REPLAY_PRODUCTION_DEPLOYMENTS: readonly string[] = [
  "clever-mockingbird-719",
  "kindly-hound-172",
  "focused-starfish-265",
];

/** Currencies whose minor-unit scale this replay states by hand: 3 for JOD/KWD/BHD/OMR, 2 for USD/EUR. */
export const REPLAY_CURRENCY_SCALES: Readonly<Record<string, number>> = {
  JOD: 3,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
};

/** The organization must have been created this recently by the seed, so a long-lived preview is not reused. */
export const REPLAY_MAX_ORG_AGE_MS = 2 * 60 * 60 * 1000;

/** What `e2eBootstrap.replayAttestation` returns. Absent or unreadable is represented by null/undefined. */
export interface ReplayAttestation {
  attested: boolean;
  reasons: readonly string[];
  deploymentName: string | null;
  markerDeploymentName: string | null;
  orgAgeMs: number | null;
}

export type ReplayEnvironment =
  | { kind: "RUN"; deployment: string }
  /** The backend did not attest an isolated, freshly seeded org. Reported as skipped, never as a pass. */
  | { kind: "NOT_RUN"; reason: string }
  /** Something that must never be written to. The replay must fail. */
  | { kind: "REFUSED"; reason: string };

/** The deployment name of a Convex URL such as https://happy-otter-123.convex.cloud, or null when it is not one. */
export function deploymentNameOf(convexUrl: string | undefined): string | null {
  if (!convexUrl) return null;
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.(?:cloud|site)(?:\/|$)/.exec(convexUrl.trim());
  return match ? match[1]! : null;
}

/**
 * Decides whether the replay may write, from the configured Convex URL and the backend's own attestation.
 * Order matters: production is refused first, then an absent or negative attestation is NOT RUN, then the three
 * names (URL, backend, marker) must agree. Only a positive attestation that names the deployment the URL
 * addresses, and the marker names the same one, is RUN.
 */
export function decideReplayEnvironment(
  convexUrl: string | undefined,
  attestation: ReplayAttestation | null | undefined,
  /**
   * The lane's explicit declaration that the org is reserved for this replay (E2E_REPLAY_DEDICATED_ORG=1), because
   * the replay's writes (a period, an opening balance) would otherwise change what later specs in the same run
   * read. It only ever NARROWS: it never substitutes for the backend's attestation.
   */
  dedicatedOrgDeclared = false
): ReplayEnvironment {
  const names = [deploymentNameOf(convexUrl), attestation?.deploymentName, attestation?.markerDeploymentName];
  const haystack = [convexUrl ?? "", ...names.map((name) => name ?? "")].join(" ");
  const production = REPLAY_PRODUCTION_DEPLOYMENTS.find((name) => haystack.includes(name));
  if (production) {
    return { kind: "REFUSED", reason: `the replay refuses a production deployment (${production})` };
  }
  if (!dedicatedOrgDeclared) {
    return {
      kind: "NOT_RUN",
      reason: "the lane did not declare the org dedicated to this replay, and its writes would change what later specs in the run read",
    };
  }
  if (!attestation) {
    return { kind: "NOT_RUN", reason: "the backend returned no attestation, so it was not shown to be a disposable preview" };
  }
  if (attestation.attested !== true) {
    return {
      kind: "NOT_RUN",
      reason: `the backend does not attest a disposable preview with a seed-created org (${attestation.reasons.join(", ") || "no reason given"})`,
    };
  }
  const [urlName, backendName, markerName] = names;
  if (!urlName || !backendName || !markerName) {
    return { kind: "REFUSED", reason: "an attested deployment must name itself in the URL, in the backend and in its marker" };
  }
  if (urlName !== backendName || backendName !== markerName) {
    return {
      kind: "REFUSED",
      reason: `the URL addresses ${urlName}, the backend reports ${backendName} and the marker vouches for ${markerName}; they must be one deployment`,
    };
  }
  if (attestation.orgAgeMs === null || attestation.orgAgeMs < 0 || attestation.orgAgeMs > REPLAY_MAX_ORG_AGE_MS) {
    return { kind: "NOT_RUN", reason: "the organization was not created by the seed within the last two hours, so it is not freshly created for this run" };
  }
  return { kind: "RUN", deployment: urlName };
}

export interface ReplayOrgFacts {
  currency: string;
  /** Accounting periods of the organization, in any status. */
  periodCount: number;
  /** Journals of the organization in ANY status (POSTED and REVERSED included). */
  journalCount: number;
  openingBalancePosted: boolean;
  pendingOpeningDraft: boolean;
  canPostDirectly: boolean;
  usableAccountCount: number;
}

/**
 * Preconditions the mutation itself enforces, read before any write. Emptiness is a SAFETY check here and not the
 * proof of freshness (that is the attestation). Returns every reason the replay must not write; empty means it may.
 */
export function replayOrgRefusals(facts: ReplayOrgFacts): string[] {
  const reasons: string[] = [];
  if (facts.periodCount !== 0) reasons.push(`the organization already holds ${facts.periodCount} accounting period(s)`);
  if (facts.journalCount !== 0) reasons.push(`the organization already holds ${facts.journalCount} journal(s) in some status`);
  if (facts.openingBalancePosted) reasons.push("an opening balance is already posted");
  if (facts.pendingOpeningDraft) reasons.push("an opening-balance draft is pending");
  if (!facts.canPostDirectly) reasons.push("the signed-in seat cannot post an opening balance directly");
  if (facts.usableAccountCount < 2) reasons.push("fewer than two active manual-posting accounts exist");
  if (!Object.prototype.hasOwnProperty.call(REPLAY_CURRENCY_SCALES, facts.currency)) {
    reasons.push(`the organization currency "${facts.currency}" is not one whose canonical minor-unit scale the replay states, so the opening balance would be refused or mis-scaled`);
  }
  return reasons;
}

export type ReplayLaneAction =
  | { action: "RUN"; deployment: string }
  /** Not run, and that is acceptable: this is not the dedicated replay lane. The test is reported as skipped. */
  | { action: "SKIP"; reason: string }
  /** The test must fail: a refused guard, or a skip in the lane that exists to run the replay. */
  | { action: "FAIL"; reason: string };

/**
 * What the replay test does with the guard's decision. `replayRequired` is the dedicated replay lane's declaration
 * (E2E_REPLAY_REQUIRED=1): there, a NOT_RUN means the attestation did not succeed, and a skipped replay would be
 * unavailable evidence reported as a green job, so it fails. It never loosens anything: REFUSED fails everywhere,
 * and RUN needs the same attestation. Outside the lane the behaviour is unchanged (skip).
 */
export function replayLaneAction(environment: ReplayEnvironment, replayRequired: boolean): ReplayLaneAction {
  if (environment.kind === "RUN") return { action: "RUN", deployment: environment.deployment };
  if (environment.kind === "REFUSED") return { action: "FAIL", reason: `GL register replay refused: ${environment.reason}` };
  if (replayRequired) {
    return { action: "FAIL", reason: `GL register replay is required in this lane but was not run: ${environment.reason}` };
  }
  return { action: "SKIP", reason: `GL register replay not run: ${environment.reason}` };
}
