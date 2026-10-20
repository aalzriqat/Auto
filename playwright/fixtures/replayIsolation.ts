// SCRUM-795: the isolation boundary of the accounting GL-register replay.
//
// The replay writes to the books: it may create or open an accounting period (which wakes held rows and
// schedules outbox work) and it posts an opening balance. That is only acceptable in a disposable, freshly
// created test organization on a deployment that is explicitly a preview or dev test deployment. Everything
// here is a pure function so a plain unit test can pin it; it imports nothing from the product.

/** Production deployments, refused whatever else is set. Hand-written, never derived. */
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

export type ReplayEnvironment =
  | { kind: "RUN"; deployment: string }
  /** The lane does not provide an isolated disposable org. Reported as NOT RUN, never as a pass. */
  | { kind: "NOT_RUN"; reason: string }
  /** Something that must never be written to. The replay must fail, not skip. */
  | { kind: "REFUSED"; reason: string };

/** The deployment name of a Convex URL such as https://happy-otter-123.convex.cloud, or null when it is not one. */
export function deploymentNameOf(convexUrl: string | undefined): string | null {
  if (!convexUrl) return null;
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.(?:cloud|site)(?:\/|$)/.exec(convexUrl.trim());
  return match ? match[1]! : null;
}

/**
 * Decides, from the configured Convex URL and the operator's explicit opt-in, whether the replay may write.
 * `disposableDeployment` is the name of the disposable test deployment the operator vouches for
 * (E2E_REPLAY_DISPOSABLE_DEPLOYMENT); it must equal the deployment the URL addresses.
 */
export function decideReplayEnvironment(
  convexUrl: string | undefined,
  disposableDeployment: string | undefined
): ReplayEnvironment {
  const haystack = `${convexUrl ?? ""} ${disposableDeployment ?? ""}`;
  const production = REPLAY_PRODUCTION_DEPLOYMENTS.find((name) => haystack.includes(name));
  if (production) {
    return { kind: "REFUSED", reason: `the replay refuses a production deployment (${production})` };
  }
  const optedIn = disposableDeployment !== undefined && disposableDeployment.trim() !== "";
  const actual = deploymentNameOf(convexUrl);
  if (!optedIn) {
    return {
      kind: "NOT_RUN",
      reason:
        "no disposable test deployment was named (E2E_REPLAY_DISPOSABLE_DEPLOYMENT), so this lane does not provide an isolated fresh org for a replay that writes to the books",
    };
  }
  if (actual === null) {
    return { kind: "REFUSED", reason: "the Convex URL does not name a deployment, so it cannot be shown to be the disposable one" };
  }
  if (actual !== disposableDeployment!.trim()) {
    return {
      kind: "REFUSED",
      reason: `the Convex URL addresses ${actual}, not the disposable deployment ${disposableDeployment!.trim()} that was named`,
    };
  }
  return { kind: "RUN", deployment: actual };
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
 * The organization must be freshly created for this run: nothing to wake, nothing to reverse, nothing to
 * conflict with the opening balance. Returns every reason the replay must not write; empty means it may.
 * A pre-existing organization (any period, any journal, any opening balance) is refused.
 */
export function replayOrgRefusals(facts: ReplayOrgFacts): string[] {
  const reasons: string[] = [];
  if (facts.periodCount !== 0) reasons.push(`the organization already holds ${facts.periodCount} accounting period(s), so it is not freshly created`);
  if (facts.journalCount !== 0) reasons.push(`the organization already holds ${facts.journalCount} journal(s) in some status, so it is not freshly created`);
  if (facts.openingBalancePosted) reasons.push("an opening balance is already posted");
  if (facts.pendingOpeningDraft) reasons.push("an opening-balance draft is pending");
  if (!facts.canPostDirectly) reasons.push("the signed-in seat cannot post an opening balance directly");
  if (facts.usableAccountCount < 2) reasons.push("fewer than two active manual-posting accounts exist");
  if (!Object.prototype.hasOwnProperty.call(REPLAY_CURRENCY_SCALES, facts.currency)) {
    reasons.push(`the organization currency "${facts.currency}" is not one whose canonical minor-unit scale the replay states, so the opening balance would be refused or mis-scaled`);
  }
  return reasons;
}
