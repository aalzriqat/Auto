/**
 * SCRUM-869 S1 / SCRUM-869#c23881: enumeration ratchets for the supplier settlement doors. The
 * reversal, unwind and correction doors of these three money flows must refuse server-side during
 * the pilot; a new public mutation here must be classified by a person.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function exportedMutations(file: string): string[] {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  return [...source.matchAll(/^export const (\w+) = mutation\(/gm)].map((m) => m[1]).sort();
}

describe("the supplier settlement mutation surface is enumerated", () => {
  // Grep-enumerated 2026-10-29. Adding a public mutation without editing this list fails here.
  test("sourcingPayables exposes only the payment and dispute doors", () => {
    expect(exportedMutations("convex/sourcingPayables.ts")).toEqual(["markPaid", "recordPartialPayment", "setDisputed"]);
  });
  test("supplierReceivables exposes only the receipt and dispute doors", () => {
    expect(exportedMutations("convex/supplierReceivables.ts")).toEqual(["recordReceipt", "setDisputed"]);
  });
  test("supplierCostRecoveries exposes the receipt door and the contained reversal", () => {
    expect(exportedMutations("convex/supplierCostRecoveries.ts")).toEqual(["recordReceipt", "reverseReceipt"]);
  });
});

describe("no screen offers the contained reversal", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sourceFiles(path, out);
      else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
    }
    return out;
  }
  test("no app, component or mobile source references supplierCostRecoveries.reverseReceipt", () => {
    const roots = ["app", "components", "lib", join("apps", "mobile", "src")];
    const offenders = roots.flatMap((root) => sourceFiles(join(process.cwd(), root))).filter((file) =>
      /supplierCostRecoveries\s*\.\s*reverseReceipt|supplierCostRecoveries:reverseReceipt/.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
