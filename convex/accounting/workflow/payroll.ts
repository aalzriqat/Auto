import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensurePayrollAccounts } from "../chartAccountsProvision";
import { postDomainEvent } from "./posting";

// ─── Payroll hooks ─────────────────────────────────────────────────────────────
// Scoped self-heal (like ensureVatReceivableAccountIfChartReady): only payroll
// events touch the salaries/employee-advance accounts, so don't add them to the
// shared postOrEnqueue choke point.
async function ensurePayrollAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePayrollAccounts(ctx, orgId, actorId);
  }
}

/** Advance issued to an employee: Dr Employee Advances (asset) / Cr cash. */
export async function hookEmployeeAdvancePaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_PAID",
    sourceType: "employeeAdvances",
    sourceId: args.advanceId.toString(),
    idempotencyKey: `employee_advance_paid_${args.advanceId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  });
}

/** Advance repaid directly (outside payroll): Dr cash / Cr Employee Advances. */
export async function hookEmployeeAdvanceRecovered(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    // Unique per recovery event so partial repayments each post their own GL
    // entry. Keying idempotency on advanceId alone would silently drop every
    // recovery after the first, under-crediting Employee Advances.
    recoveryId: Id<"employeeAdvanceRecoveries">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_RECOVERED",
    sourceType: "employeeAdvances",
    sourceId: `recovery_${args.recoveryId}`,
    idempotencyKey: `employee_advance_recovered_${args.recoveryId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  });
}

/** Salary accrued for one employee on a run: Dr Salaries Expense / Cr Salaries Payable. */
export async function hookPayrollAccrued(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    runId: Id<"payrollRuns">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_ACCRUED",
    sourceType: "payrollItems",
    sourceId: `accrued_${args.itemId}`,
    idempotencyKey: `payroll_accrued_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      runId: args.runId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/** One employee's payslip payment (clears salary + commission payables, recovers advance, pays net). */
export async function hookPayrollPaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    userId: Id<"users">;
    salaryMinor: number;
    commissionMinor: number;
    openingCommissionSettlements?: import("../../utils/openingCommissionBasis").OpeningCommissionSettlement[];
    advanceRecoveredMinor: number;
    netMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  },
  openingReader?: import("../../utils/openingSettlementBasis").OpeningSettlementReader
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_PAID",
    sourceType: "payrollItems",
    sourceId: `paid_${args.itemId}`,
    idempotencyKey: `payroll_paid_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      itemId: args.itemId.toString(),
      userId: args.userId.toString(),
      salaryMinor: args.salaryMinor,
      commissionMinor: args.commissionMinor,
      ...(args.openingCommissionSettlements?.length ? { openingCommissionSettlements: args.openingCommissionSettlements } : {}),
      advanceRecoveredMinor: args.advanceRecoveredMinor,
      netMinor: args.netMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId.toString() } : {}),
    },
  }, openingReader);
}
