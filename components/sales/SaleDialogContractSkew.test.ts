/**
 * SCRUM-724 deploy-skew guard. The frontend auto-deploys from main; the Convex
 * backend deploy is manual. A completed-sale edit/cancel dialog that issues
 * `api.sales.cancellationReceiptStatus` (new in this stack) would call a function an
 * older backend lacks the moment the frontend ships. Until a later UI change lands
 * AFTER the backend deploy, no frontend file may reference it, and SaleDialog
 * must not pass the stack's new `customerPaymentDisposition`/`customerRefund*`
 * arguments to `sales.update`.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["components", "app", "hooks", "lib"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("SCRUM-724 frontend/backend deploy skew", () => {
  test("no frontend file calls api.sales.cancellationReceiptStatus", () => {
    const offenders = SCAN_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((file) => readFileSync(file, "utf8").includes("cancellationReceiptStatus"));
    expect(offenders).toEqual([]);
  });

  test("SaleDialog sends none of the stack's new sales.update arguments", () => {
    const source = readFileSync(join(ROOT, "components", "sales", "SaleDialog.tsx"), "utf8");
    expect(source).not.toMatch(/customerPaymentDisposition|customerRefund/);
  });
});
