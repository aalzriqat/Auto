import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * SCRUM-264 Seat 2 round 3 (PR #741): every writer of `collectionPayments.paymentDate` records what that
 * value IS in `paymentDateKind`, because timestamp equality (`createdAt === paymentDate`) cannot say
 * whether it is a calendar key or an instant.
 *
 * Behaviour of the writers that tests can drive is asserted where they are driven (recordPayment in
 * collectionsOrgDayProvenance.scrum264.test.ts, clearCheque in collections.test.ts, deposit receipt and
 * refund in deposits.test.ts, the deposit slice payout in multiVehicleDepositAllocation.test.ts, the sale
 * date refund in consignedDepositResolution.test.ts). Two writers sit behind doors that are switched off
 * (payment-link settlement, manager refund approval), so no test can run them; this source check is the
 * only evidence for those, and it also stops a NEW writer from skipping the field.
 * (A test file may read source with node:fs; it is not bundled into the Convex runtime.)
 */

const CONVEX_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "_generated" || entry === "node_modules") continue;
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(path);
  }
  return files;
}

interface InsertSite {
  file: string;
  /** The text of the object literal passed to `insert("collectionPayments", {...})`. */
  literal: string;
}

function collectionPaymentInserts(): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const path of sourceFiles(CONVEX_DIR)) {
    const text = readFileSync(path, "utf8");
    let from = 0;
    for (;;) {
      const at = text.indexOf('ctx.db.insert("collectionPayments"', from);
      if (at < 0) break;
      const open = text.indexOf("{", at);
      let depth = 0;
      let close = open;
      for (; close < text.length; close += 1) {
        if (text[close] === "{") depth += 1;
        if (text[close] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      sites.push({ file: relative(CONVEX_DIR, path).replace(/\\/g, "/"), literal: text.slice(open, close + 1) });
      from = close;
    }
  }
  return sites;
}

// The kind each writer must store, matched by a fact only that writer has in its literal.
const EXPECTED: Array<{ file: string; marker: RegExp; kind: RegExp; label: string }> = [
  {
    file: "collections.ts",
    marker: /paymentDate: args\.paymentDate/,
    kind: /paymentDateKind: paymentDateKindOfCalendarInput\(args\.paymentDate\)/,
    label: "recordPayment (a key when the form sent a UTC midnight)",
  },
  { file: "collections.ts", marker: /chequeId: args\.chequeId/, kind: /paymentDateKind: "instant"/, label: "clearCheque" },
  { file: "collections.ts", marker: /Refund approval/, kind: /paymentDateKind: "instant"/, label: "refund approval" },
  { file: "paymentIntents.ts", marker: /paymentDate: occurredAt/, kind: /paymentDateKind: "instant"/, label: "payment intent settlement" },
  { file: "utils/depositRecording.ts", marker: /Deposit \$\{depositId\}/, kind: /paymentDateKind: "instant"/, label: "deposit receipt" },
  { file: "utils/depositHelpers.ts", marker: /Deposit slice refund/, kind: /paymentDateKind: "instant"/, label: "payOutDepositSlice" },
  {
    file: "utils/depositHelpers.ts",
    marker: /Deposit refund \$\{args\.depositId\}/,
    kind: /paymentDateKind: args\.occurredAt === undefined \? "instant" : "saleDate"/,
    label: "releaseHeldDeposit (a sale date when sale completion passes one)",
  },
];

describe("SCRUM-264: every collectionPayments writer records what paymentDate is", () => {
  const sites = collectionPaymentInserts();

  test("the writers are exactly the seven this change enumerated, so a new one cannot slip in unclassified", () => {
    expect(sites.map((s) => s.file).sort()).toEqual(
      [
        "collections.ts",
        "collections.ts",
        "collections.ts",
        "paymentIntents.ts",
        "utils/depositHelpers.ts",
        "utils/depositHelpers.ts",
        "utils/depositRecording.ts",
      ].sort(),
    );
  });

  test.each(EXPECTED)("$label stores the kind it knows", ({ file, marker, kind }) => {
    const matching = sites.filter((s) => s.file === file && marker.test(s.literal));
    expect(matching, `exactly one ${file} writer matches ${marker}`).toHaveLength(1);
    expect(matching[0]!.literal).toMatch(kind);
  });

  test("no writer takes the kind from a heuristic or leaves it out", () => {
    for (const site of sites) {
      expect(site.literal, `${site.file} sets paymentDateKind`).toMatch(/paymentDateKind:/);
      expect(site.literal, `${site.file} never derives it from createdAt`).not.toMatch(/paymentDateKind:[^,\n]*createdAt/);
    }
  });
});