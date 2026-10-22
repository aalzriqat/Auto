/**
 * SCRUM-724 deploy-skew guard. The frontend auto-deploys from main; the Convex
 * backend deploy is manual. A completed-sale edit/cancel dialog that issues
 * `api.sales.cancellationReceiptStatus` (new in this stack) would call a function an
 * older backend lacks the moment the frontend ships. Until a later UI change lands
 * AFTER the backend deploy, no frontend file may reference it, and SaleDialog
 * must not pass the stack's new `customerPaymentDisposition`/`customerRefund*`
 * arguments to `sales.update`.
 *
 * SCRUM-724 mount PR (replaces the F1/FS-01 "NOT mounted" guards): the backend
 * that owns the operator money UI was deployed (PR #562, merged 4734f5f80,
 * deployed to production at c2b2ec33f), so the deal-page invoice-receipts panel
 * and the Approvals-tab retained-credit refund queue are now MOUNTED. The guard
 * is no longer "nothing references these functions" but "every function the
 * mounted money UI calls exists in this repository's backend as a public
 * function of the kind the hook needs, and accepts every argument the UI sends".
 * A missing function makes `useQuery` throw during render; a missing argument
 * makes the mutation fail argument validation on every click.
 *
 * SCRUM-822 FU-1: the old guard matched dotted substrings only, so a bracket
 * reference (`api["collections"]["x"]`) slipped past it, and it never checked the
 * new `invoiceSaleId` argument on the pre-existing `collections.recordPayment`.
 * Both are covered below, with a negative control for the extractor.
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

const read = (...segments: string[]) => readFileSync(join(ROOT, ...segments), "utf8");

type HookKind = "query" | "mutation";
type ApiReference = { path: string; hook: HookKind | null };

/** A segment of an `api` reference: `.name`, `["name"]`, `['name']` or `` [`name`] ``. */
const SEGMENT = /\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'`])([A-Za-z_$][\w$/]*)\2\s*\])/y;
const HOOK_BEFORE = /\b(useQuery|usePaginatedQuery|useMutation)\(\s*$/;

/**
 * Every `api.<module>.<function>` reference in `source`, dotted or bracketed, with
 * the Convex hook it is passed to (null when it is not passed straight to one).
 */
function apiReferences(source: string): ApiReference[] {
  const found: ApiReference[] = [];
  const start = /\bapi(?=\s*[.[])/g;
  for (let match = start.exec(source); match !== null; match = start.exec(source)) {
    const segments: string[] = [];
    SEGMENT.lastIndex = match.index + 3;
    for (let seg = SEGMENT.exec(source); seg !== null; seg = SEGMENT.exec(source)) {
      segments.push(seg[1] ?? seg[3]);
    }
    if (segments.length < 2) continue;
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    const hook = HOOK_BEFORE.exec(before)?.[1];
    found.push({
      path: `${segments.slice(0, -1).join("/")}:${segments[segments.length - 1]}`,
      hook: hook === undefined ? null : hook === "useMutation" ? "mutation" : "query",
    });
  }
  return found;
}

type RegisteredFunction = {
  isQuery?: boolean;
  isMutation?: boolean;
  isPublic?: boolean;
  exportArgs?: () => string;
};

async function backendFunction(path: string): Promise<RegisteredFunction | undefined> {
  const [modulePath, name] = path.split(":");
  const mod = (await import(`../../convex/${modulePath}.ts`)) as Record<string, unknown>;
  return mod[name] as RegisteredFunction | undefined;
}

function argKeys(fn: RegisteredFunction): string[] {
  const args = JSON.parse(fn.exportArgs!()) as { type: string; value?: Record<string, unknown> };
  return args.type === "object" ? Object.keys(args.value ?? {}) : [];
}

const PANEL = ["components", "applications", "cockpit", "DealInvoiceReceiptsPanel.tsx"];
const SECTION = ["components", "accounting", "RetainedCreditRefundsSection.tsx"];
const DEAL_CLIENT = ["app", "(dashboard)", "[orgId]", "sales", "[saleId]", "deal", "client.tsx"];
const COLLECTIONS_TAB = ["components", "accounting", "CollectionsTab.tsx"];
const CLEAR_CHEQUE_BANK_DIALOG = ["components", "accounting", "ClearChequeBankDialog.tsx"];
const RECEIPT_BANK_SELECT = ["components", "accounting", "ReceiptBankSelect.tsx"];
const MOUNTED_MONEY_UI = [PANEL, SECTION, DEAL_CLIENT, COLLECTIONS_TAB, CLEAR_CHEQUE_BANK_DIALOG, RECEIPT_BANK_SELECT];

/**
 * The arguments each mounted money mutation is sent by the panel / queue. Every
 * key must be accepted by the deployed validator. A new mutation call in the
 * money UI must add its row here (the completeness check below enforces it).
 */
const SENT_ARGS: Record<string, string[]> = {
  "collections:recordPayment": ["orgId", "customerId", "invoiceSaleId", "amount", "method", "bankAccountId", "paymentDate", "reference", "idempotencyKey"],
  "collections:reserveSaleInvoiceReceipt": ["orgId", "saleId", "receiptMovementId", "amountMinor", "idempotencyKey"],
  "collections:activateSaleInvoiceReceipt": ["orgId", "applicationId", "amountMinor", "idempotencyKey"],
  "collections:registerSaleInvoiceCheque": ["orgId", "saleId", "bank", "chequeNumber", "chequeDate", "amountMinor"],
  "collections:depositCheque": ["orgId", "chequeId"],
  "collections:clearCheque": ["orgId", "chequeId", "bankAccountId", "idempotencyKey"],
  "retainedCreditRefunds:requestRetainedCreditRefund": ["orgId", "receiptMovementId", "amountMinor", "method", "reason"],
  "retainedCreditRefunds:respondToRetainedCreditRefund": ["orgId", "requestId", "status", "idempotencyKey"],
  "retainedCreditRefunds:executeRetainedCreditRefund": ["orgId", "requestId", "reference", "paidAt", "idempotencyKey"],
  "retainedCreditRefunds:cancelRetainedCreditRefund": ["orgId", "requestId", "reason"],
};

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

describe("SCRUM-724 mount: the operator money UI is mounted", () => {
  test("the deal page renders DealInvoiceReceiptsPanel beside the cockpit", () => {
    const source = read(...DEAL_CLIENT);
    expect(source).toMatch(/import\s*\{[^}]*\bDealInvoiceReceiptsPanel\b[^}]*\}\s*from\s*"@\/components\/applications\/cockpit\/DealInvoiceReceiptsPanel"/);
    expect(source).toMatch(/<DealInvoiceReceiptsPanel\b/);
  });

  test("Collections renders RetainedCreditRefundsSection on the Approvals tab for approvers OR finance managers", () => {
    const source = read(...COLLECTIONS_TAB);
    expect(source).toMatch(/import\s*\{\s*RetainedCreditRefundsSection\s*\}\s*from\s*"\.\/RetainedCreditRefundsSection"/);
    expect(source).toMatch(/<RetainedCreditRefundsSection\b/);
    expect(source).toMatch(/\(canApprove \|\| canManage\) && <TabsTrigger value="approvals">/);
  });
});

describe("SCRUM-724 mount: every backend function the mounted money UI calls exists (FU-1)", () => {
  const references = MOUNTED_MONEY_UI.flatMap((file) => apiReferences(read(...file)));
  const paths = [...new Set(references.map((ref) => ref.path))].sort();

  test("the extractor is not vacuous: it finds the money functions the panel and the queue call", () => {
    for (const expected of [
      ...Object.keys(SENT_ARGS),
      "collections:saleInvoiceReceiptStatus",
      "collections:listRetainedCredits",
      "collections:listSaleCustomerCheques",
      "collections:summary",
      "retainedCreditRefunds:listRetainedCreditRefundRequests",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test("negative control: the extractor sees bracket and mixed access, not just dotted access", () => {
    const sample = [
      `useMutation(api["collections"]["recordPayment"])`,
      `useQuery(api.retainedCreditRefunds['listRetainedCreditRefundRequests'], args)`,
      "usePaginatedQuery(api[`collections`].listSaleCustomerCheques, a, b)",
      `const x = api.nested.dir.fn;`,
    ].join("\n");
    expect(apiReferences(sample)).toEqual([
      { path: "collections:recordPayment", hook: "mutation" },
      { path: "retainedCreditRefunds:listRetainedCreditRefundRequests", hook: "query" },
      { path: "collections:listSaleCustomerCheques", hook: "query" },
      { path: "nested/dir:fn", hook: null },
    ]);
  });

  test("every reference is passed straight to a Convex hook, so its kind can be checked", () => {
    expect(references.filter((ref) => ref.hook === null)).toEqual([]);
  });

  test.each(paths)("%s exists as a public function of the kind its hook needs", async (path) => {
    const fn = await backendFunction(path);
    expect(fn, `${path} is not exported by convex/`).toBeDefined();
    expect(fn!.isPublic).toBe(true);
    const kinds = new Set(references.filter((ref) => ref.path === path).map((ref) => ref.hook));
    for (const kind of kinds) {
      if (kind === "mutation") expect(fn!.isMutation, `${path} is used with useMutation`).toBe(true);
      if (kind === "query") expect(fn!.isQuery, `${path} is used with useQuery/usePaginatedQuery`).toBe(true);
    }
  });

  test("every money mutation the panel and the queue call has a sent-arguments row", () => {
    const moneyMutations = [PANEL, SECTION, CLEAR_CHEQUE_BANK_DIALOG]
      .flatMap((file) => apiReferences(read(...file)))
      .filter((ref) => ref.hook === "mutation")
      .map((ref) => ref.path);
    expect([...new Set(moneyMutations)].sort()).toEqual(Object.keys(SENT_ARGS).sort());
  });

  test.each(Object.entries(SENT_ARGS))("%s accepts every argument the UI sends", async (path, sent) => {
    const fn = await backendFunction(path);
    expect(fn?.exportArgs, `${path} has no argument validator`).toBeTypeOf("function");
    const accepted = argKeys(fn!);
    expect(sent.filter((key) => !accepted.includes(key))).toEqual([]);
  });

  test("collections.recordPayment accepts the sale-invoice binding the deal panel sends (invoiceSaleId)", async () => {
    const fn = await backendFunction("collections:recordPayment");
    expect(argKeys(fn!)).toContain("invoiceSaleId");
    expect(read(...PANEL)).toMatch(/recordPayment\(\{[^}]*\binvoiceSaleId: saleId\b/);
  });

  test("the availability flags the UI reads are reported by the backend", () => {
    const collections = read("convex", "collections.ts");
    expect(collections).toMatch(/saleInvoiceDoorsAvailable:/);
    expect(collections).toMatch(/retainedCreditPayoutAvailable:/);
    expect(read(...PANEL)).toMatch(/status\?\.saleInvoiceDoorsAvailable === true/);
    expect(read(...PANEL)).toMatch(/status\?\.retainedCreditPayoutAvailable === true/);
    expect(read(...COLLECTIONS_TAB)).toMatch(/summary\?\.retainedCreditPayoutAvailable === true/);
  });
});
