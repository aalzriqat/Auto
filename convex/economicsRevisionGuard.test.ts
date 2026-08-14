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
 * silently, which is the exact defect the stamp replaced.
 *
 * Not a hypothetical risk. I hand-fixed the three writers I could find, wrote
 * this, and it immediately named a fourth and a fifth — the shared recompute,
 * which moves the funding split without touching the approved amount, and the
 * branch that clears the split when no basis is available.
 *
 * The self-tests come first on purpose: a guard nobody has watched fail is not
 * a guard. They pin that the analyzer flags an unbumped write and clears a
 * bumped one, that it reads whole payloads, that it covers `replace` as well as
 * `patch`, and that it descends into subdirectories — so an edit that neuters
 * any of that fails here rather than quietly passing everything. That last one
 * is not decoration either: the first version of this scanned `convex/` alone
 * while claiming to cover the backend, and an external reviewer caught it.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
 * The write primitives that can move a stored field.
 *
 * `replace` appears nowhere in the backend today. It is scanned anyway, because
 * the cost of listing it is one array entry and the cost of omitting it is the
 * whole guarantee the first time somebody reaches for it — and a guard that
 * covers only the primitive in use when it was written is a guard with an
 * expiry date nobody records.
 */
const WRITE_PRIMITIVES = ["ctx.db.patch(", "ctx.db.replace("];

/**
 * Every write payload in the source, as text.
 *
 * Brace-matched rather than regex-terminated: these payloads contain nested
 * objects and spreads, and a pattern that stopped at the first `}` would read
 * half a patch and clear it on the strength of what it could not see.
 */
function patchPayloads(source: string): string[] {
  const payloads: string[] = [];
  for (const marker of WRITE_PRIMITIVES) {
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
  }
  return payloads;
}

/**
 * Every backend source file under `convex/`, at any depth.
 *
 * RECURSIVE, and that is the whole point: the first version of this walked
 * `convex/` alone, so a writer added under `convex/utils/`, `convex/accounting/`
 * or `convex/validations/` would have sailed past a guard whose own comment
 * claimed to cover every economics write in the backend. No such writer existed
 * yet — `convex/utils/financingEconomics.ts` names these fields thirteen times
 * and patches nothing — so this closes a latent hole rather than a live one.
 * The self-test below pins the recursion, because a scan that silently stops
 * descending looks exactly like a codebase with nothing to report.
 */
function backendSourceFiles(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(root, entry.name);
      // `_generated` is codegen: it holds no handwritten writer, and scanning it
      // would make this test fail on a regenerated API rather than on a defect.
      if (entry.isDirectory()) return entry.name === "_generated" ? [] : backendSourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
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

  test("flags an unbumped ctx.db.replace as readily as a patch", () => {
    const replaced = UNBUMPED.replace("ctx.db.patch(", "ctx.db.replace(");
    expect(findUnbumpedEconomicsWrites(replaced, "sample.ts")).toHaveLength(1);
  });

  test("descends into subdirectories", () => {
    // The hole sol found: a non-recursive walk clears a nested writer without
    // ever opening it. Written to a real nested path under a temp root, so the
    // recursion is exercised rather than asserted about.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "economics-guard-"));
    try {
      const nested = path.join(root, "utils", "deep");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "writer.ts"), UNBUMPED, "utf8");
      // ...and codegen stays out of it, so a regenerated API cannot fail this.
      fs.mkdirSync(path.join(root, "_generated"));
      fs.writeFileSync(path.join(root, "_generated", "api.ts"), UNBUMPED, "utf8");

      const files = backendSourceFiles(root).map((f) => path.relative(root, f));
      expect(files).toEqual([path.join("utils", "deep", "writer.ts")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    const offences = backendSourceFiles(CONVEX_ROOT).flatMap((file) =>
      findUnbumpedEconomicsWrites(
        fs.readFileSync(file, "utf8"),
        path.relative(CONVEX_ROOT, file)
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
