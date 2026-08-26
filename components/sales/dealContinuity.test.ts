import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { quoteLineageFor, type DealContinuation } from "./DealContinuityNotice";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * SCRUM-195 — THE CLIENT MUST BE ABLE TO REACH WHAT THE BACKEND ENFORCES.
 *
 * Two reviewers found the same thing independently on frozen head 684ee9ef, and
 * a complete caller inventory confirmed it: `intent: "REVISE"` with
 * `supersedesQuoteId`, and `adoptReservationId`, were enforced by `saveQuote`
 * and reachable from NO shipped client. All four call sites — two web, two
 * mobile — spread their payload and then wrote `intent: "NEW" as const` AFTER
 * the spread, so the literal won by construction rather than by omission.
 *
 * The backend enforced a capability the product never exposed, and the person
 * on the shop floor met that enforcement as an unexplained refusal on the
 * customer's deposit one screen later.
 *
 * ⚠️ This file is a SCOPED SENTINEL, not a proof. It reads source text. It
 * cannot tell you the screen works — the rendered check and the Convex
 * contracts in `vehicleCommitmentAuthority.test.ts` do that. What it does is
 * make the specific regression that shipped here impossible to reintroduce
 * QUIETLY: a new `saveQuote` call site either derives its lineage or is
 * recorded below as a deliberate gap, with a reason somebody wrote down.
 */

const ROOT = path.resolve(__dirname, "../..");

/**
 * Call sites that still hardcode `intent: "NEW"`, and why that is a decision
 * rather than an oversight.
 *
 * ⚠️ NOT AN ALLOWLIST TO GROW CASUALLY. Each entry is a capability a real user
 * cannot reach on that client. They are listed so the gap is visible in the
 * repository and in review, instead of being indistinguishable from a call site
 * nobody thought about — which is exactly how the original defect survived.
 */
const KNOWN_GAPS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "apps/mobile/src/features/workspace/modules/quotes.tsx",
    reason:
      "React Native. The web flow derives lineage from `commitments.dealContinuation` and explains it in a notice before the salesperson commits; auto-applying it on mobile WITHOUT that explanation would silently continue a deal the user did not choose to continue, which is the inference this whole lane exists to forbid. Until the mobile screen can show the same explanation, mobile keeps opening independent deals and meets the server's refusal — correct behaviour, missing capability.",
  },
  {
    file: "apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx",
    reason:
      "React Native, same reason as the mobile quotes module above: the capability is only safe to apply once the screen can EXPLAIN it, and this wizard has no equivalent of the continuity notice yet. Recorded rather than quietly fixed, because auto-deriving lineage behind the user is the inference c14865 forbids by name.",
  },
];

function callSitesOfSaveQuote(): string[] {
  const roots = ["components", "app", "apps/mobile/src", "lib"];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      const source = fs.readFileSync(full, "utf8");
      // The CALL, not the declaration and not a comment mentioning it.
      if (/await saveQuote\(\{/.test(source)) {
        found.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return found.sort();
}

describe("every shipped saveQuote caller can reach the lineage the backend enforces", () => {
  test("the inventory is not empty — a sentinel that finds nothing proves nothing", () => {
    // If a refactor renames the mutation or changes the call shape, this fails
    // loudly rather than passing with zero files examined.
    expect(callSitesOfSaveQuote().length).toBeGreaterThanOrEqual(4);
  });

  test("each caller either derives its lineage or is a recorded gap", () => {
    const gaps = new Map(KNOWN_GAPS.map((g) => [g.file, g.reason]));
    const offenders: string[] = [];

    for (const file of callSitesOfSaveQuote()) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const derivesLineage = /quoteLineageFor\(/.test(source);
      if (derivesLineage) continue;

      const reason = gaps.get(file);
      if (!reason) {
        offenders.push(
          `${file} hardcodes its intent and is not a recorded gap. Derive it with quoteLineageFor(), or add it to KNOWN_GAPS with a reason.`
        );
        continue;
      }
      expect(reason.length, `${file}'s recorded reason must actually say something`).toBeGreaterThan(
        80
      );
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("a recorded gap that has since been fixed must be removed from the list", () => {
    // Keeps the list honest in the other direction: a stale entry would go on
    // describing a hole that no longer exists, and the next reader would trust it.
    for (const gap of KNOWN_GAPS) {
      const full = path.join(ROOT, gap.file);
      expect(fs.existsSync(full), `${gap.file} no longer exists — remove or update the entry`).toBe(
        true
      );
      const source = fs.readFileSync(full, "utf8");
      expect(
        /quoteLineageFor\(/.test(source),
        `${gap.file} now derives its lineage — delete its KNOWN_GAPS entry`
      ).toBe(false);
    }
  });
});

describe("the lineage a save carries", () => {
  const quoteId = "q1" as Id<"quotes">;
  const reservationId = "r1" as Id<"vehicleReservations">;

  test("a live quote on the same car is REVISED, not duplicated", () => {
    const continuation: DealContinuation = {
      kind: "REVISE_QUOTE",
      quoteId,
      vehiclePrice: 28_000,
      createdAt: 0,
      revision: 2,
      unresolvedMoneyMinor: 300_000,
      unresolvedMoney: 3_000,
      currency: "JOD",
    };
    // The whole point: money already on the deal follows the deal forward
    // instead of being stranded on a superseded quote.
    expect(quoteLineageFor(continuation)).toEqual({ intent: "REVISE", supersedesQuoteId: quoteId });
  });

  test("their own reservation is ADOPTED, so the deposit is not a rival", () => {
    const continuation: DealContinuation = {
      kind: "ADOPT_RESERVATION",
      reservationId,
      reservedAt: 0,
      expiresAt: null,
      depositAmount: 5_000,
    };
    expect(quoteLineageFor(continuation)).toEqual({ intent: "NEW", adoptReservationId: reservationId });
  });

  test("a free car opens an independent deal", () => {
    expect(quoteLineageFor({ kind: "NEW" })).toEqual({ intent: "NEW" });
  });

  test("an unanswered query never invents lineage", () => {
    // ⚠️ `undefined` is the loading state. Guessing REVISE here would silently
    // supersede somebody's live quote on a slow connection.
    expect(quoteLineageFor(undefined)).toEqual({ intent: "NEW" });
  });

  test("a blocked car claims no lineage it cannot prove", () => {
    expect(quoteLineageFor({ kind: "HELD_BY_ANOTHER_DEAL" })).toEqual({ intent: "NEW" });
    expect(quoteLineageFor({ kind: "AMBIGUOUS" })).toEqual({ intent: "NEW" });
  });
});
