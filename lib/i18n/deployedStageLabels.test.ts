import { describe, expect, test } from "vitest";
import { salesEn, salesAr } from "./domains/sales";
import {
  CASH_DEAL_STAGE_ORDER,
  DEAL_STAGE_BLOCKERS,
  DEAL_STAGE_ORDER,
} from "../../convex/utils/financingEconomics";

/**
 * The release-skew contract between this backend and the DEPLOYED cockpit.
 *
 * ## Why this exists
 *
 * This PR ships backend changes ahead of the frontend that consumes them,
 * deliberately: the production Convex deploy only accepts `main`'s current tip,
 * so a PR's own head cannot be deployed before it is merged, and merging
 * auto-promotes the frontend. Backend-before-frontend therefore cannot be
 * enforced from one PR, and the compatibility boundary is drawn in source
 * instead.
 *
 * That makes "the currently deployed cockpit still renders correctly against
 * this backend" a real, load-bearing claim — and until this file existed it was
 * a claim verified once by hand and by nothing afterwards.
 *
 * ## The specific failure this catches
 *
 * The deployed cockpit resolves a stage label as `t(STAGE_LABEL[key] ?? key)`,
 * and `LanguageProvider`'s `t()` returns the KEY ITSELF when it has no
 * translation. So a stage key the backend emits that the deployed build does
 * not know renders as a bare upper-case identifier — `DISBURSEMENT` — to
 * operators, in Arabic as well as English, for the whole window between the
 * backend deploy and the frontend release. Not a crash, which is exactly why it
 * would have shipped unnoticed.
 *
 * ## Scope, stated honestly
 *
 * This asserts label RESOLVABILITY, not layout, and it is TRANSITIONAL: it
 * describes the deployed build's behaviour during one release window. Delete it
 * together with the transitional `DISBURSEMENT` entry once the new cockpit is
 * live, since at that point both sides move together and the contract is no
 * longer skewed.
 */
describe("deployed cockpit can label every stage this backend emits", () => {
  /**
   * The stage keys the DEPLOYED build already knows, snapshotted from
   * `STAGE_LABEL` in `components/applications/cockpit/DealCockpit.tsx` at the
   * base commit this release deploys against.
   *
   * Hardcoded on purpose. The point of comparison is what is RUNNING IN
   * PRODUCTION, not what is in this working tree — reading the local component
   * would compare the backend against a frontend nobody is using yet and quietly
   * assert nothing. It cannot be read from git either: CI checks out at depth 1,
   * which is what made an earlier `git diff`-based guard in this lane unrunnable.
   */
  const DEPLOYED_STAGE_LABEL_KEYS = new Set([
    "SALE_AGREED",
    "APPLICATION",
    "CREDIT_DECISION",
    "APPRAISAL",
    "GAP_RESOLUTION",
    "APPROVED_PURCHASE",
    "DELIVERY_ACTIONS",
    "HANDOVER",
    "SETTLEMENT",
  ]);

  const everyStageKey = [...DEAL_STAGE_ORDER, ...CASH_DEAL_STAGE_ORDER];

  test.each(everyStageKey)(
    "%s resolves to real copy on the deployed rail, in both locales",
    (stageKey) => {
      if (DEPLOYED_STAGE_LABEL_KEYS.has(stageKey)) {
        // The deployed build maps it to a `Stage*` key of its own; that key's
        // translations are covered by the dictionaries' own tests.
        return;
      }

      // Not known to the deployed build, so it falls through to `t(rawKey)` and
      // MUST have an entry under the raw key in both catalogs. Without one the
      // operator reads the identifier itself.
      const en = (salesEn as Record<string, string>)[stageKey];
      const ar = (salesAr as Record<string, string>)[stageKey];

      expect(
        en,
        `The deployed cockpit does not know the stage "${stageKey}", so it renders t("${stageKey}"). ` +
          `Add a transitional English entry under that exact key, or the operator sees the raw identifier.`
      ).toBeTruthy();
      expect(
        ar,
        `Same for Arabic: "${stageKey}" has no transitional entry, so the Arabic rail would render the ` +
          `English-looking identifier.`
      ).toBeTruthy();

      // A translation that merely echoes the key is the same failure wearing a
      // dictionary entry.
      expect(en).not.toBe(stageKey);
      expect(ar).not.toBe(stageKey);
    }
  );

  /**
   * The blocker sub-label, which reaches the operator through a DIFFERENT and
   * more fragile path than the stage label above.
   *
   * The deployed cockpit builds this key by interpolation —
   * ``t(`Blocker${stage.blocker}`)`` at `DealCockpit.tsx:1732` and `:1766` —
   * with no `STAGE_LABEL`-style indirection to fall back on. There is no
   * allowlist to consult and nothing to snapshot: EVERY blocker the backend can
   * emit must have a translation under its interpolated key, or the operator
   * reads a bare identifier where the reason for the hold should be.
   *
   * `lib/i18n/keyCoverage.test.ts` documents that its static scans cannot see
   * this path and rests on "every member resolves today". This change added the
   * first new member since that was written — `AwaitingDisbursement` — so the
   * hand-checked guarantee is replaced here with an enforced one.
   */
  test.each(DEAL_STAGE_BLOCKERS)(
    "the blocker %s resolves to real copy in both locales",
    (blocker) => {
      const key = `Blocker${blocker}`;
      const en = (salesEn as Record<string, string>)[key];
      const ar = (salesAr as Record<string, string>)[key];

      expect(
        en,
        `The rail can emit blocker "${blocker}", which the cockpit renders as t("${key}"). ` +
          `Without an English entry the operator reads the identifier instead of the reason.`
      ).toBeTruthy();
      expect(ar, `Same for Arabic: "${key}" has no entry.`).toBeTruthy();
      expect(en).not.toBe(key);
      expect(ar).not.toBe(key);
    }
  );

  test("the transitional entry is the one the deployed build actually needs", () => {
    // Guards the removal step: if DISBURSEMENT ever leaves the stage order, this
    // fails and the transitional entry should go with it rather than lingering.
    expect(DEAL_STAGE_ORDER).toContain("DISBURSEMENT");
    expect(DEPLOYED_STAGE_LABEL_KEYS.has("DISBURSEMENT")).toBe(false);
  });
});
