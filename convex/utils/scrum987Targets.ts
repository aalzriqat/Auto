// SCRUM-987 slice 1 — the allow-listed production targets. Split from scrum987CancelledDealReversal.ts (file-size guardrail); no logic here.
export const SCRUM987_REASON = "SCRUM-987 owner ruling 2026-11-23";
export const SCRUM987_ORG_ID = "pd7pw6zrrz9q9ke4sdv6xtw6tn8g8v5n";
/** The UTC month the correction must be dated into (the open November period). */
export const SCRUM987_EXPECTED_UTC_MONTH = "2026-11";

export interface CorrectionTarget {
  label: string;
  applicationId: string;
  feeId: string;
  custodyId: string;
  entryId: string;
  /** Fee amount == custody issued == ISSUED entry amount, in minor units. */
  amountMinor: number;
  /** Whether the deal was finalized then unwound (sale CANCELLED, finalizedSaleId kept). */
  finalized: boolean;
}

/** Production ids and amounts read 2026-11-23 (invariant packet, table §1). */
export const SCRUM987_TARGETS: ReadonlyArray<CorrectionTarget> = [
  {
    label: "D-000012",
    applicationId: "qs7en3pgh408khqsagjphgqhrx8jdxzf",
    feeId: "rh716g08tzs0kjq8xh1kcprvfs8jdgfp",
    custodyId: "r976ejw9pca01ckx442f48pk6s8jdynn",
    entryId: "rd73sbrcqf3qfecr4v6m0rxx3h8jce2s",
    amountMinor: 582_150,
    finalized: false,
  },
  {
    label: "D-000015",
    applicationId: "qs7dq0emdxtb7m65kbfgca41398jc811",
    feeId: "rh71aasc38t34x4g22gmpvxhws8jcyy5",
    custodyId: "r97cy2f8t6gqex3zn5hgm2kz1x8jdmct",
    entryId: "rd725v20e792s89e4n0b5vah3n8jd1ph",
    amountMinor: 870_000,
    finalized: false,
  },
  {
    label: "D-000016",
    applicationId: "qs70da2paqr67nvawywa4tnxfn8jcnds",
    feeId: "rh7evqeycaesbde744d9tep0n18jdezs",
    custodyId: "r97f74vwqhfd2v7kspzep6pmvn8jc536",
    entryId: "rd7eqpry1j41gw6ch7z3tn4k9s8jckf7",
    amountMinor: 870_000,
    finalized: true,
  },
];

// ─── Slice 2: D-000021 (owner ruling 2026-11-24) ────────────────────────────
// A SEPARATE batch, never appended to SCRUM987_TARGETS: the planner refuses a mix of corrected and uncorrected
// targets, and slice 1 is already applied in production. Same org and expected month.
export const SCRUM987_D21_REASON = "SCRUM-987 owner ruling 2026-11-24";

/** Production ids and amounts read 2026-11-24 (read-only query). */
export const SCRUM987_D21_TARGETS: ReadonlyArray<CorrectionTarget> = [
  {
    label: "D-000021",
    applicationId: "qs72np7y2n2kfhr5s74fh6nr998jp2kg",
    feeId: "rh7e9xvxx4dfvj9x7c7n9wn8cn8jv2r1",
    custodyId: "r978e75ek6cfwcxmeknx0tn1ws8jt5cf",
    entryId: "rd7c91fdr2x70cjtcfn4c80ypd8jvfvd",
    amountMinor: 472_000,
    finalized: false,
  },
];
