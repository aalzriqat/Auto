/**
 * SCRUM-724 deploy-skew guard. The frontend auto-deploys from main; the Convex
 * backend deploy is manual. A completed-sale edit/cancel dialog that issues
 * `api.sales.cancellationReceiptStatus` (new in this stack) would call a function an
 * older backend lacks the moment the frontend ships. Until a later UI change lands
 * AFTER the backend deploy, no frontend file may reference it, and SaleDialog
 * must not pass the stack's new `customerPaymentDisposition`/`customerRefund*`
 * arguments to `sales.update`.
 *
 * SCRUM-724 F1/FS-01: the same applies to the operator money UI. The deal-page
 * invoice-receipts panel and the Approvals-tab retained-credit refund queue read
 * `collections.saleInvoiceReceiptStatus`, `collections.listSaleCustomerCheques`
 * and `api.retainedCreditRefunds.*`, none of which exist on origin/main's backend.
 * A missing function makes useQuery throw and crashes the route. The component
 * files ship in this PR but stay UNMOUNTED; the mount lands in a follow-up PR
 * after the manual Convex backend deploy.
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

  const NEW_BACKEND_REFERENCES = [
    "saleInvoiceReceiptStatus",
    "listSaleCustomerCheques",
    "registerSaleInvoiceCheque",
    "reserveSaleInvoiceReceipt",
    "activateSaleInvoiceReceipt",
    "api.retainedCreditRefunds",
  ];
  const UNMOUNTED_COMPONENTS = [
    join("components", "applications", "cockpit", "DealInvoiceReceiptsPanel.tsx"),
    join("components", "accounting", "RetainedCreditRefundsSection.tsx"),
  ];
  const allSources = () => SCAN_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  test("SCRUM-724 F1/FS-01: no mounted frontend file references backend functions missing on main", () => {
    const allowed = new Set(UNMOUNTED_COMPONENTS.map((rel) => join(ROOT, rel)));
    const offenders = allSources()
      .filter((file) => !allowed.has(file))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return NEW_BACKEND_REFERENCES.some((needle) => text.includes(needle));
      })
      .map((file) => file.replace(ROOT, ""));
    expect(offenders).toEqual([]);
  });

  test("SCRUM-724 F1/FS-01: the unmounted money components are imported by no other file", () => {
    const own = new Set(UNMOUNTED_COMPONENTS.map((rel) => join(ROOT, rel)));
    const offenders = allSources()
      .filter((file) => !own.has(file))
      .filter((file) => /\b(DealInvoiceReceiptsPanel|RetainedCreditRefundsSection)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(ROOT, ""));
    expect(offenders).toEqual([]);
  });
});
