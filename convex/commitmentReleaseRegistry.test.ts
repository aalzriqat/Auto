import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * SCRUM-195 — every place that ends a hold must say what happens to the claim.
 *
 * ## Why this test exists
 *
 * Five separate defects in this lane were the same defect: a rule applied to
 * some writers of a record and not all of them. `assertCurrentRevision` reached
 * two evidence doors and not sale completion. `commitmentRoots.customerId` was
 * in the merge registry's coverage list and not its rewrite list. Reservation
 * EXPIRY released the vehicle hold and not the claim. Deposit refund, forfeit
 * and void did the same.
 *
 * Four of the five were found by reading the code, not by a failing gate — and
 * the one that a gate did catch was caught by `customerMergeRegistry.test.ts`,
 * which works exactly like this: enumerate the real writers from the SOURCE,
 * and refuse any that is neither handled nor explicitly declared as deliberate.
 *
 * ## What this is, exactly
 *
 * A SCOPED SENTINEL, not a proof. It watches the literal hold-ending sites in
 * three named files and refuses one that is neither handled nor declared. That
 * is narrow on purpose and it is not authority that the commitment lifecycle is
 * correct — a behavioural test proves a path; this only proves nobody added a
 * hold-ending write in these files without deciding what happens to the claim.
 *
 * It did not, for instance, cover customer deletion at all, because that is not
 * a hold-ending write — and that was the sixth instance of the same class,
 * found by hand immediately after this test was written.
 *
 * ## What counts as ending a hold
 *
 * `holdActive: false` on a deposit, or a reservation leaving ACTIVE. Those are
 * the two writes that stop a piece of evidence holding a car. Every one of them
 * has to either release the commitment claim, or say in this registry why it
 * deliberately does not — never be silently absent from both.
 *
 * ## What this cannot prove
 *
 * That a declared reason is TRUE. `keeps` entries are documentation with a
 * forced author, not verification; the behaviour behind them lives in the
 * corpus (8.3 is the one that matters most — money still held means the deal
 * keeps its car), and each one still owes its own behavioural contract there.
 *
 * That the three files are the only places such a write could appear. A new one
 * in a fourth file is invisible here.
 *
 * That any rule OTHER than claim-release-on-hold-end is satisfied. Lifecycle,
 * deletion and merge rules are out of its scope entirely.
 *
 * What it does catch is the case nobody thought about at all, in the files
 * where these writes actually live.
 */

type Site = {
  file: string;
  fn: string;
  /** The claim-release call this site is required to make. */
  releases?: string;
  /** Or why it deliberately makes none. */
  keeps?: string;
};

const REGISTRY: Site[] = [
  // ── Endings that genuinely finish a deal: the claim goes. ─────────────────
  {
    file: "deposits.ts",
    fn: "voidDeposit",
    releases: "releaseClaimsForDeposit",
  },
  {
    file: "utils/depositHelpers.ts",
    fn: "releaseHeldDeposit",
    releases: "releaseClaimsForDeposit",
  },
  {
    file: "vehicles.ts",
    fn: "releaseReservation",
    releases: "releaseClaimsForReservation",
  },
  {
    file: "vehicles.ts",
    fn: "expireReservations",
    releases: "releaseClaimsForReservation",
  },
  {
    file: "vehicles.ts",
    fn: "createReservation",
    releases: "releaseClaimsForReservation",
  },
  {
    file: "utils/depositHelpers.ts",
    fn: "releaseMatchingReservationHoldsForQuote",
    releases: "releaseClaimsForReservation",
  },

  // ── Endings that deliberately keep the claim. ─────────────────────────────
  {
    file: "utils/depositHelpers.ts",
    fn: "releaseQuoteDepositHolds",
    keeps:
      "A rejected application stops the deposit counting toward RESERVED inventory, but the MONEY IS STILL HELD — a manager has yet to refund or forfeit it, so the deal keeps its car. Releasing here hands the car to a rival while the first customer's money sits against it; contract 8.3 refuses that by name.",
  },
  {
    file: "utils/depositHelpers.ts",
    fn: "recordUnpostedDepositTreatment",
    keeps:
      "Records that somebody chose a treatment the system does not post. Its own code says 'status deliberately untouched — the money is still held', so the same reasoning as releaseQuoteDepositHolds applies.",
  },
  {
    file: "utils/depositHelpers.ts",
    fn: "resolveDepositsForQuote",
    keeps:
      "Runs inside sale completion, where the claims are CONSUMED rather than released — a sold car is not a free one. Releasing would be inert anyway, since only ACTIVE claims are resolvable.",
  },
  {
    file: "utils/depositHelpers.ts",
    fn: "releaseReservationDepositHold",
    keeps:
      "Only reachable from releaseMatchingReservationHoldsForQuote, which releases the reservation's claim one level up. A reservation-linked deposit carries no DEPOSIT claim of its own — createReservation attaches a RESERVATION claim, and deposits.create is never involved.",
  },
];

/** A deposit stops holding, or a reservation stops being ACTIVE. */
const HOLD_ENDING = /holdActive:\s*false|status:\s*"(?:EXPIRED|RELEASED)"/;

const FUNCTION_START =
  /^(?:export\s+)?(?:const\s+(\w+)\s*=\s*(?:mutation|internalMutation|query|action)|(?:export\s+)?(?:async\s+)?function\s+(\w+))/;

const SOURCES = ["deposits.ts", "vehicles.ts", "utils/depositHelpers.ts"];

type Found = { file: string; fn: string; body: string };

function scan(): Found[] {
  const found: Found[] = [];

  for (const file of SOURCES) {
    const source = readFileSync(resolve(process.cwd(), "convex", file), "utf8");
    const lines = source.replace(/\r\n/g, "\n").split("\n");

    const starts: Array<{ line: number; fn: string }> = [];
    lines.forEach((line, index) => {
      const match = FUNCTION_START.exec(line);
      if (match) starts.push({ line: index, fn: match[1] ?? match[2] });
    });

    lines.forEach((line, index) => {
      if (!HOLD_ENDING.test(line)) return;

      const owner = [...starts].reverse().find((s) => s.line <= index);
      if (!owner) return;
      const next = starts.find((s) => s.line > owner.line);
      const body = lines.slice(owner.line, next?.line ?? lines.length).join("\n");

      const already = found.find((f) => f.file === file && f.fn === owner.fn);
      if (!already) found.push({ file, fn: owner.fn, body });
    });
  }

  return found;
}

const key = (s: { file: string; fn: string }) => `${s.file}::${s.fn}`;

describe("commitment release registry", () => {
  test("every source site that ends a hold is registered", () => {
    const discovered = scan().map(key).sort();
    const registered = REGISTRY.map(key).sort();

    // Both directions. An unregistered site is the defect this exists to
    // catch; a registered site that no longer exists means the registry is
    // describing code that is gone, and would mask the next one.
    expect(discovered).toEqual(registered);
  });

  test("each registered site either releases the claim or says why not", () => {
    const found = scan();

    for (const entry of REGISTRY) {
      const site = found.find((f) => key(f) === key(entry));
      expect(site, `${key(entry)} is registered but was not found in source`).toBeTruthy();
      if (!site) continue;

      expect(
        Boolean(entry.releases) !== Boolean(entry.keeps),
        `${key(entry)} must declare exactly one of releases/keeps — never both, never neither`,
      ).toBe(true);

      if (entry.releases) {
        expect(
          site.body,
          `${key(entry)} is registered as releasing via ${entry.releases}, but that call is not in its body. ` +
            `A hold that ends without releasing its claim leaves the car held by evidence that no longer exists.`,
        ).toContain(entry.releases);
      } else {
        expect(
          (entry.keeps ?? "").length,
          `${key(entry)} keeps its claim, so it owes a reason`,
        ).toBeGreaterThan(80);
      }
    }
  });
});
