/**
 * SCRUM-771 — when the Jev form explorer is opted in, "could not explore" is a
 * FAILURE, never a skip and never an empty pass (SCRUM-760 ruling 3:
 * cannot-run = FAIL). Before the nightly opted it in, the test always stopped
 * at its opt-in skip, so a refusal, a wrong organization or an empty attempt
 * pool could not hide behind a green run. Now they can, so each one has to
 * stop the run with the reason.
 *
 * Pure so it can be unit-tested; the spec calls it at the three points where
 * an opted-in run could otherwise end without exploring.
 */
export type ExplorerRunState = {
  /** The attestation's refusal, when it refused. */
  refusal?: string;
  /** The organization the app opened, once known. */
  openedOrgId?: string;
  /** The organization the backend attested as the seeded QA org. */
  attestedOrgId?: string;
  /** The configured attempt budget, once the run reaches its end. */
  maxAttempts?: number;
  /** Attempts actually made, once the run reaches its end. */
  attempts?: number;
};

/**
 * Attempts that reached the form's Save. A record whose setup failed (form did
 * not open, picker or fill failed) pressed nothing, so it is not an attempt.
 */
export function submittedAttempts(records: readonly { verdict: { check: string } }[]): number {
  return records.filter((r) => r.verdict.check !== "setup").length;
}

/** Why an opted-in run did not explore, or undefined when it may go on / did explore. */
export function explorerDidNotRun(s: ExplorerRunState): string | undefined {
  if (s.refusal) return `the preview attestation refused: ${s.refusal}`;
  if (s.openedOrgId !== undefined && s.openedOrgId !== s.attestedOrgId) {
    return `the app opened organization ${s.openedOrgId}, not the attested QA organization ${s.attestedOrgId ?? "(none)"}`;
  }
  // A budget of 0 is an explicit discovery-only run; anything else must attack.
  if (s.maxAttempts !== undefined && s.maxAttempts > 0 && (s.attempts ?? 0) === 0) {
    return "no attempt was made: every form was unreachable or no field had a rule to try";
  }
  return undefined;
}
