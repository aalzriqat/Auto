/**
 * Contract test for the economics revision counter.
 *
 * `registerVehicleHandover` refuses a confirmation whose `economicsStamp` no
 * longer matches the deal, and that stamp is `economicsRevision` and nothing
 * else. So the guarantee holds only while every write that moves the deal's
 * economics also bumps the counter.
 *
 * A forgotten bump fails OPEN: the stamp keeps comparing equal, and a
 * confirmation taken against figures that have since changed seals anyway —
 * silently, which is the exact defect the stamp replaced. Fixing today's three
 * writers does not stop the fourth. This does.
 *
 * The self-tests come first on purpose: a guard nobody has watched fail is not
 * a guard. They pin that the analyzer flags a patch that moves the approved
 * amount without bumping, and clears the same patch once it does — so an edit
 * that neuters the analyzer fails here rather than passing everything.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONVEX_ROOT = path.resolve(__dirname);

/**
 * The figures the handover confirmation is about. A write that moves any of
 * them invalidates a confirmation an operator is holding.
 */
const ECONOMICS_FIELDS = [
  "approvedDealerPurchaseAmountMinor",
  "financeCompanyFundedPortionMinor",
  "dealerContributionMinor",
  "unfinancedPortionMinor",
];

type Offence = { file: string; snippet: string };

/**
 * Every `ctx.db.patch(...)` object literal in the source, as text.
 *
 * Brace-matched rather than regex-terminated: these payloads contain nested
 * objects and spreads, and a pattern that stopped at the first `}` would read
 * half a patch and clear it on the strength of what it could not see.
 */
function patchPayloads(source: string): string[] {
  const payloads: string[] = [];
  const marker = "ctx.db.patch(";
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    const open = source.indexOf("{", cursor);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    payloads.push(source.slice(open, end + 1));
    cursor = source.indexOf(marker, end);
  }
  return payloads;
}

/**
 * A patch WRITES one of the figures when the field appears as a key. A patch
 * that merely reads one into a different key (`...ApprovedAtRecordingMinor:
 * app.approvedDealerPurchaseAmountMinor`) is copying evidence, not moving the
 * deal, and must not be forced to bump.
 */
function movesEconomics(payload: string): boolean {
  return ECONOMICS_FIELDS.some((field) => new RegExp(`(^|[\\s{,])${field}\\s*:`, "m").test(payload));
}

function findUnbumpedEconomicsWrites(source: string, file: string): Offence[] {
  return patchPayloads(source)
    .filter((payload) => movesEconomics(payload) && !/economicsRevision\s*:/.test(payload))
    .map((payload) => ({ file, snippet: payload.slice(0, 160) }));
}

const BUMPED = `
    await ctx.db.patch(args.applicationId, {
      economicsRevision: (app.economicsRevision ?? 0) + 1,
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      updatedAt: now,
    });
`;

const UNBUMPED = `
    await ctx.db.patch(args.applicationId, {
      approvedDealerPurchaseAmountMinor: args.approvedAmountMinor,
      updatedAt: now,
    });
`;

/** Copying the approved amount into settlement evidence moves no economics. */
const EVIDENCE_ONLY = `
    await ctx.db.patch(args.applicationId, {
      supplierDisbursementApprovedAtRecordingMinor: app.approvedDealerPurchaseAmountMinor,
      updatedAt: now,
    });
`;

describe("the analyzer itself", () => {
  test("flags a patch that moves the approved amount without bumping", () => {
    expect(findUnbumpedEconomicsWrites(UNBUMPED, "sample.ts")).toHaveLength(1);
  });

  test("clears the same patch once it bumps", () => {
    expect(findUnbumpedEconomicsWrites(BUMPED, "sample.ts")).toHaveLength(0);
  });

  test("does not demand a bump for a patch that only copies the figure", () => {
    expect(findUnbumpedEconomicsWrites(EVIDENCE_ONLY, "sample.ts")).toHaveLength(0);
  });

  test("reads a whole payload rather than stopping at the first nested brace", () => {
    // The bump sits AFTER a nested object here, so a non-brace-matched reader
    // would miss it and report a false offence.
    const nested = `
    await ctx.db.patch(id, {
      snapshot: { basis: "APPRAISAL" },
      approvedDealerPurchaseAmountMinor: amount,
      economicsRevision: (app.economicsRevision ?? 0) + 1,
    });
`;
    expect(findUnbumpedEconomicsWrites(nested, "sample.ts")).toHaveLength(0);
  });
});

describe("every economics writer in convex/ bumps the revision", () => {
  test("no unbumped write reaches the deal's economics", () => {
    const offences = fs
      .readdirSync(CONVEX_ROOT)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .flatMap((name) =>
        findUnbumpedEconomicsWrites(
          fs.readFileSync(path.join(CONVEX_ROOT, name), "utf8"),
          name
        )
      );

    expect(
      offences,
      `These patches move the deal's economics without bumping economicsRevision, so a
handover confirmation taken before them would still compare equal and seal:

${offences.map((o) => `  ${o.file}: ${o.snippet.replace(/\s+/g, " ")}`).join("\n")}
`
    ).toEqual([]);
  });
});
