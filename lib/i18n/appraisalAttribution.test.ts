import { describe, expect, test } from "vitest";
import { salesEn, salesAr } from "./domains/sales";

/**
 * No string may attribute the vehicle appraisal to the finance company.
 *
 * ## Why this file exists rather than another component test
 *
 * The cockpit now displays who performed the appraisal, from recorded server
 * provenance. Three consecutive review sweeps then found three DIFFERENT
 * elements that hardcoded "the finance company" as the appraiser — the rail
 * badge would say "An independent appraiser" while a card below said the
 * appraisal was the finance company's. Each round fixed the surface that had
 * been NAMED and the next round found another one.
 *
 * That is a line-shaped repair for an invariant-shaped defect. So the invariant
 * is asserted over the DICTIONARY rather than over a list of components: any
 * new string that talks about an appraisal is covered the moment it is added,
 * without anyone remembering to extend a component test.
 *
 * ## Why it reads the real dictionaries
 *
 * The cockpit component tests mock `t` with the identity function, so they
 * assert KEY NAMES and are structurally blind to what the copy actually says.
 * `TheirAppraisalLabel` passed every one of them while its Arabic value read
 * "تخمين شركة التمويل للمركبة" — literally "THE FINANCE COMPANY'S appraisal of
 * the vehicle". Only the real dictionary can catch that, so this file reads it.
 */

/** Words that mean "appraisal" in each language. */
const APPRAISAL_TERMS = [/appraisal/i, /تخمين/];

/** Words that name the finance company in each language. */
const FINANCE_COMPANY_TERMS = [/finance company/i, /شركة التمويل/];

/**
 * Arabic attaches possession as a SUFFIX, so "تخمينها" ("its appraisal", the
 * ـها referring to the feminine شركة التمويل) names the finance company without
 * containing the phrase. A substring check alone reads it as neutral, which is
 * exactly how it survived two review rounds.
 */
const IMPLICIT_POSSESSIVE = [
  /تخمينها/,
  /\btheir appraisal\b/i,
];

/**
 * Strings that legitimately mention both, because they are about the finance
 * company's APPROVED AMOUNT — a genuinely finance-company fact — while also
 * saying an appraisal cannot be recorded. Allowlisted deliberately and
 * individually; never widen this to a pattern.
 */
const ALLOWED = new Set([
  // "…an appraisal can no longer be recorded … A manager records the amount
  // the finance company approved instead." The APPROVED AMOUNT is genuinely
  // theirs; the sentence never claims they appraised.
  "AppraisalClosedByHandover",
  // "…Recording one now withdraws that approval, and the finance company's
  // amount will have to be recorded again." Same shape — this guard flagged it
  // on CO-OCCURRENCE, and co-occurrence is not attribution. Kept as a false
  // positive I dispositioned rather than "fixed" by damaging correct copy.
  "AppraisalWithdrawsApproval",
]);

function offendingKeys(dict: Record<string, unknown>): string[] {
  return Object.entries(dict)
    .filter(([key, value]) => {
      if (ALLOWED.has(key) || typeof value !== "string") return false;
      const mentionsAppraisal = APPRAISAL_TERMS.some((r) => r.test(value));
      if (!mentionsAppraisal) return false;
      return (
        FINANCE_COMPANY_TERMS.some((r) => r.test(value)) ||
        IMPLICIT_POSSESSIVE.some((r) => r.test(value))
      );
    })
    .map(([key]) => key);
}

describe("no copy attributes the appraisal to the finance company", () => {
  test("English", () => {
    expect(offendingKeys(salesEn)).toEqual([]);
  });

  test("Arabic", () => {
    // The language where this actually shipped. Arabic states the party
    // outright ("تخمين شركة التمويل") where English hid behind a pronoun.
    expect(offendingKeys(salesAr)).toEqual([]);
  });

  test("the guard is not vacuous — it sees a planted violation", () => {
    // Without this, deleting every appraisal string, or breaking the regexes,
    // would make the two tests above pass while proving nothing.
    expect(offendingKeys({ Planted: "Their appraisal of the vehicle" })).toEqual(["Planted"]);
    expect(offendingKeys({ Planted: "تخمين شركة التمويل للمركبة" })).toEqual(["Planted"]);
    expect(offendingKeys({ Planted: "تخمينها" })).toEqual(["Planted"]);
  });

  test("neutral appraisal copy is NOT flagged", () => {
    // The counter-case. A guard that flags every appraisal string would force
    // the copy to stop mentioning appraisals at all, which is not the property.
    expect(offendingKeys({ Ok: "Recorded appraisal of the vehicle" })).toEqual([]);
    expect(offendingKeys({ Ok: "التخمين المسجَّل للمركبة" })).toEqual([]);
    // …and a finance-company string that is not ABOUT an appraisal is fine.
    expect(offendingKeys({ Ok: "Waiting on the finance company to pay" })).toEqual([]);
  });
});
