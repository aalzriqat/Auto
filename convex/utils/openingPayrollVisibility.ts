import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "./defaultChart";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";

/** Shared with the opening draft and posted-allocation readers. */
export function canReadOpeningPayroll(role: Doc<"roles">): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_PAYROLL) ||
    role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
}

/** The maintenance reader withholds employee void reasons without payroll authority. */
export function canManageOpeningPayroll(role: Doc<"roles">): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
}

/** Legacy openings can carry employee control lines without allocations. */
export async function containsEmployeeAdvanceControl(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  draft: Doc<"openingBalanceDrafts">,
  readAccount: (id: Id<"chartOfAccounts">) => Promise<Doc<"chartOfAccounts"> | null> = id => ctx.db.get(id),
): Promise<boolean> {
  if (draft.allocations?.some(row => row.kind === "EMPLOYEE_ADVANCE" || row.kind === "EMPLOYEE_COMMISSION")) return true;
  for (const line of draft.lines) {
    const account = await readAccount(line.accountId);
    if (account?.orgId === orgId && (account.systemKey === SYSTEM_KEYS.EMPLOYEE_ADVANCES || account.systemKey === SYSTEM_KEYS.COMMISSION_PAYABLE)) return true;
  }
  return false;
}
