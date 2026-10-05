import { MutationCtx, internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import {
  DEFAULT_ROLE_TEMPLATES,
  LEGACY_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_OWNER_ROLE_NAME,
  isReservedRoleName,
  isSystemOwnerRole,
  isUnqualifiedOwnerNamed,
  needsOwnerFlagStamp,
  normalizeRoleName,
} from "./utils/permissions";

export const fixExistingRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;

    for (const role of roles) {
      // Find the corresponding template
      const template = DEFAULT_ROLE_TEMPLATES.find((t) => normalizeRoleName(t.name) === normalizeRoleName(role.name));
      // SCRUM-413 S413B-3: never write an unqualified OWNER-named row (see isUnqualifiedOwnerNamed).
      if (isUnqualifiedOwnerNamed(role)) continue;
      if (template) {
        // We only want to ensure VIEW_USERS is present for these specific roles
        // Or we can just sync the permissions entirely if they haven't been customized,
        // but for safety, let's just add VIEW_USERS if it's in the template but missing from the DB.

        if (template.permissions.includes("view:users") && !role.permissions.includes("view:users")) {
          await ctx.db.patch(role._id, {
            permissions: [...role.permissions, "view:users"],
          });
          updatedCount++;
        }
      }
    }

    return `Fixed ${updatedCount} roles by adding view:users permission.`;
  },
});

/**
 * Shared by the capability-matching backfills below: patches a role with
 * whichever permissions from `toAdd` it's missing, and — for an OWNER-named row
 * that ALREADY qualifies as the system owner (`isSystemOwnerRole`, evaluated
 * before the write) — explicitly sets `isSystemOwnerRole: true`. An OWNER-named
 * row that does not qualify is not written at all (SCRUM-413 S413B-3). That flag matters
 * beyond just the permissions array: `isSystemOwnerRole()`'s fallback check
 * (see utils/permissions.ts) requires the stored `permissions` array to
 * contain the frozen pre-SCRUM-413 owner set, so a row missing the explicit
 * flag depends on that legacy list forever. (It used to require every
 * currently-defined permission, which failed closed on every addition.)
 */
async function patchRoleIfNeeded(
  ctx: MutationCtx,
  role: Doc<"roles">,
  toAdd: Set<string>,
  updates: string[]
): Promise<boolean> {
  // SCRUM-413 S413B-3: never write an unqualified OWNER-named row (see isUnqualifiedOwnerNamed).
  if (isUnqualifiedOwnerNamed(role)) return false;
  const ownerNamed = isReservedRoleName(role.name);

  const missing = [...toAdd].filter((p) => !role.permissions.includes(p));
  const isStaleOwnerRow = ownerNamed && role.isSystemOwnerRole !== true;
  if (missing.length === 0 && !isStaleOwnerRow) return false;

  await ctx.db.patch(role._id, {
    permissions: [...role.permissions, ...missing],
    ...(ownerNamed ? { isSystemOwnerRole: true } : {}),
  });
  updates.push(`${role.name} (${role.orgId}): +${missing.join(", ")}`);
  return true;
}

/**
 * One-time backfill for the new finance-application permissions (Phase 9 / PR #2).
 * Matches by existing capability rather than role name, since orgs can rename
 * roles (e.g. a "SALES" role renamed to "المبيعات" still has create:sales).
 */
export const backfillFinanceApplicationPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Finance/accounting-capable roles get visibility + disbursement confirmation.
      if (has("manage:finance") || has("view:finance")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
        toAdd.add(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
      }
      // Roles that already approve other requests get approval authority.
      // (SCRUM-413: this backfill used to add finalize:financed_deal too; that
      // permission is retired and no backfill may mint it.)
      if (has("approve:requests")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
      }
      // Sales-capable roles can view/create applications for deals they work.
      if (has("create:sales")) {
        toAdd.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
        toAdd.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
      }
      // Owners always get full finance-application authority. requireTenantAuth
      // exempts only the immutable system owner role from permission checks; this
      // keeps the stored permission list accurate for UI display.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        [
          PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
          PERMISSIONS.CREATE_FINANCE_APPLICATION,
          PERMISSIONS.REVIEW_FINANCE_APPLICATION,
          PERMISSIONS.APPROVE_FINANCE_APPLICATION,
          PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
          PERMISSIONS.VERIFY_FINANCE_DOCUMENTS,
        ].forEach((p) => toAdd.add(p));
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new REOPEN_PERIODS permission (accounting
 * autonomy remediation, Phase 7). Deliberately narrower than every backfill
 * above: this permission is NOT granted to any capability-matched role, only
 * to OWNER rows — the whole point is that an org grants it to a controller
 * role explicitly, not automatically to whoever already holds MANAGE_FINANCE
 * (the default ACCOUNTANT template shouldn't gain the ability to reopen a
 * closed period just because this migration ran). Still needed for every
 * OWNER row regardless: any legacy OWNER row missing the explicit
 * isSystemOwnerRole flag fails the isSystemOwnerRole() fallback check the
 * instant ANY new permission is added to the PERMISSIONS registry, not just
 * this one — see patchRoleIfNeeded's own comment.
 */
export const backfillReopenPeriodsPermission = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      if (!(isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME)) continue;

      const toAdd = new Set<string>([PERMISSIONS.REOPEN_PERIODS]);
      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new Dealer Network Marketplace permissions
 * (Phase 56/57, PR #52). Same capability-matching approach as
 * backfillFinanceApplicationPermissions above: any org whose OWNER role
 * predates this PR still has `isSystemOwnerRole` unset, which makes the
 * `isSystemOwnerRole()` fallback check in utils/permissions.ts fail closed
 * against *every* newly-added permission (not just these three) until the
 * row is explicitly flagged — see that function's own comment. This also
 * fixes that root cause going forward for the affected org, not just this
 * one permission set.
 */
export const backfillMarketplacePermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Manager-capable roles (website management is a reliable MANAGER-only
      // signal in the default templates, unlike name which orgs can rename).
      if (has(PERMISSIONS.WEBSITE_MANAGE)) {
        toAdd.add(PERMISSIONS.MARKETPLACE_SETTINGS);
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
        toAdd.add(PERMISSIONS.MARKETPLACE_ANALYTICS);
      }
      // Sales-capable roles only get the day-to-day action, matching the
      // SALES default template (not settings/analytics).
      if (has(PERMISSIONS.CREATE_SALES_REQUEST)) {
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
      }
      // Owners always get full marketplace authority, same reasoning as the
      // finance-application backfill above.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.MARKETPLACE_SETTINGS);
        toAdd.add(PERMISSIONS.MARKETPLACE_RESPOND);
        toAdd.add(PERMISSIONS.MARKETPLACE_ANALYTICS);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new expense permissions added to the ACCOUNTANT
 * default template (accounting-pilot readiness review). `manage:finance` is
 * a reliable ACCOUNTANT-only signal among the default templates — MANAGER
 * doesn't hold it — same capability-matching approach as the two backfills
 * above, so a renamed ACCOUNTANT role (or a custom role built with the same
 * capability) still gets picked up.
 */
export const backfillAccountantExpensePermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      if (has(PERMISSIONS.MANAGE_FINANCE)) {
        toAdd.add(PERMISSIONS.CREATE_EXPENSES);
        toAdd.add(PERMISSIONS.EDIT_EXPENSES);
      }
      // Owners always get every permission, same reasoning as the backfills above.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.CREATE_EXPENSES);
        toAdd.add(PERMISSIONS.EDIT_EXPENSES);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for the new SENIOR_ACCOUNTANT role template (founder-
 * independence readiness review). Unlike the backfills above, this doesn't
 * patch an existing role's permissions — it INSERTS the new role for every
 * org that already runs finance day-to-day (has an ACCOUNTANT-capable role,
 * i.e. one holding manage:finance) but has no SENIOR_ACCOUNTANT row yet, so
 * the role is selectable in Team settings without waiting for the org to
 * create it manually. Idempotent: an org that already has a role named
 * SENIOR_ACCOUNTANT (however its permissions were customized) is skipped
 * rather than getting a duplicate. Assigning any member to the new role is
 * left to the org — this only makes the role available.
 */
/**
 * Grant the new payroll permissions to roles that should have them: every
 * OWNER (so isSystemOwnerRole keeps holding — a new PERMISSIONS entry otherwise
 * breaks it for legacy owner rows), any role that already manages FINANCE, and
 * any role still named after a default template whose template now carries
 * payroll permissions. Deliberately NOT granted from manage:commissions alone —
 * payroll (salaries, advances) is a finance capability, and a commissions-only
 * role must not silently become a payroll administrator. Run once after
 * deploying the payroll feature.
 */
export const backfillPayrollPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // Payroll is a FINANCE capability, not a commissions one: salaries and
      // advances are sensitive, so a role that only manages commissions must
      // NOT silently become a payroll administrator. Finance-managing roles
      // get both; roles still named after a default template whose template
      // now carries payroll permissions get exactly what the template grants
      // (mirrors what a fresh org would create). Renamed custom roles beyond
      // that are a deliberate manual grant by the org owner.
      if (has(PERMISSIONS.MANAGE_FINANCE)) {
        toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }
      const template = DEFAULT_ROLE_TEMPLATES.find(
        (t) => normalizeRoleName(t.name) === normalizeRoleName(role.name)
      );
      if (template) {
        if (template.permissions.includes(PERMISSIONS.VIEW_PAYROLL)) toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        if (template.permissions.includes(PERMISSIONS.MANAGE_PAYROLL)) toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }
      // Owners always get every permission.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.VIEW_PAYROLL);
        toAdd.add(PERMISSIONS.MANAGE_PAYROLL);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

/**
 * One-time backfill for `edit:vehicle_valuations`, which replaced
 * `edit:vehicles` as the gate on `finance.saveValuation`.
 *
 * This backfill is not optional: without it the change is a REGRESSION for
 * every existing org. A MANAGER-shaped role could save valuations before (it
 * holds `edit:vehicles`) and would silently lose that ability, since the
 * mutation no longer accepts `edit:vehicles`.
 *
 * Capability-matched rather than name-matched, since orgs rename roles. The
 * `VIEW_VEHICLE_VALUATIONS` conjunct is deliberate: it keeps the backfill from
 * handing write access to a custom role that was never allowed to even see
 * valuations.
 */
export const backfillVehicleValuationPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    let updatedCount = 0;
    const updates: string[] = [];

    for (const role of roles) {
      if (role.isDeleted) continue;
      const has = (p: string) => role.permissions.includes(p);
      const toAdd = new Set<string>();

      // MANAGER-shaped (edit:vehicles) keeps the access it already had;
      // SALES-shaped (edit:vehicles:request) gains it — the point of the change.
      const canChangeVehicleData =
        has(PERMISSIONS.EDIT_VEHICLES) || has(PERMISSIONS.EDIT_VEHICLES_REQUEST);
      if (canChangeVehicleData && has(PERMISSIONS.VIEW_VEHICLE_VALUATIONS)) {
        toAdd.add(PERMISSIONS.EDIT_VEHICLE_VALUATIONS);
      }

      // Owners always retain full authority, same reasoning as the backfills above.
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        toAdd.add(PERMISSIONS.EDIT_VEHICLE_VALUATIONS);
      }

      if (await patchRoleIfNeeded(ctx, role, toAdd, updates)) updatedCount++;
    }

    return { updatedCount, updates };
  },
});

export const backfillSeniorAccountantRole = internalMutation({
  args: {},
  handler: async (ctx) => {
    const allRoles = await ctx.db.query("roles").collect();
    const rolesByOrg = new Map<string, Doc<"roles">[]>();
    for (const role of allRoles) {
      if (role.isDeleted) continue;
      const key = role.orgId.toString();
      const list = rolesByOrg.get(key);
      if (list) list.push(role);
      else rolesByOrg.set(key, [role]);
    }

    const template = DEFAULT_ROLE_TEMPLATES.find((t) => t.name === "SENIOR_ACCOUNTANT");
    if (!template) throw new Error("SENIOR_ACCOUNTANT template not found in DEFAULT_ROLE_TEMPLATES.");

    let createdCount = 0;
    const created: string[] = [];

    for (const [orgId, orgRoles] of rolesByOrg) {
      const hasAccountantCapability = orgRoles.some((r) => r.permissions.includes(PERMISSIONS.MANAGE_FINANCE));
      const hasSeniorAccountantAlready = orgRoles.some(
        (r) => normalizeRoleName(r.name) === normalizeRoleName("SENIOR_ACCOUNTANT")
      );
      if (!hasAccountantCapability || hasSeniorAccountantAlready) continue;

      await ctx.db.insert("roles", {
        orgId: orgRoles[0].orgId,
        name: template.name,
        permissions: [...template.permissions],
      });
      createdCount++;
      created.push(orgId);
    }

    return { createdCount, created };
  },
});

/** One stored role's part in the SCRUM-413 read-back report. */
interface SplitDealAuthorityRecord {
  roleId: Id<"roles">;
  orgId: Id<"organizations">;
  name: string;
  /** Recognised as the owner by `isSystemOwnerRole` (flag, or the frozen fallback). */
  ownerQualified: boolean;
  /**
   * An unflagged row that qualifies as the owner only through the frozen name
   * fallback: it still needs the explicit flag (the template sync, or any
   * backfill, stamps it). Reported only here.
   */
  stampOwnerFlag: boolean;
  /** Named like the owner and NOT qualified (unflagged or explicit false): reported, never stamped. */
  ownerFlagSkipped: boolean;
  /** Still stores a retired permission string. Inert: no door reads it. */
  carriesRetiredPermission: boolean;
  /** Holds the route authority (`manage:supplier_settlement`). */
  holdsRoute: boolean;
  /** Holds the closed-deal cancel authority (`cancel:closed_deal`). */
  holdsCancelClosed: boolean;
}

/**
 * SCRUM-413, read-back report (DIAGNOSTIC ONLY — it writes nothing).
 *
 * PR-A used this to give stored roles the split deal authorities before the
 * doors moved. The doors have moved (`manage:supplier_settlement` and
 * `cancel:closed_deal`), `finalize:financed_deal` is retired, and no role
 * writer or backfill grants authority implicitly any more — so there is
 * nothing left to apply. What remains is the owner's inventory: which stored
 * roles still carry the inert retired string, which hold each new authority,
 * and which OWNER-named rows are unflagged and fail the frozen fallback.
 *
 * `ready` means ALL of: no stored role carries a retired permission string
 * (`retiredCarriers`), no qualifying owner is still unflagged
 * (`unstampedOwners`), and no unflagged OWNER-named row fails the frozen
 * fallback (`unqualifiedOwnerNamed`). The retired string itself is inert (no
 * door reads it), so that part is hygiene; the owner counts are about identity.
 * Stamp-only rows are reported even when they carry no retired string. An
 * OWNER-named row with an explicit `isSystemOwnerRole: false` does not qualify
 * either, so it is counted in `unqualifiedOwnerNamed` (an owner-review item)
 * and is never stamped.
 */
export const prepareSplitDealAuthorities = internalQuery({
  args: {},
  handler: async (ctx) => {
    const roles = await ctx.db.query("roles").collect();
    const records: SplitDealAuthorityRecord[] = [];
    let carriers = 0;
    let unstampedOwners = 0;
    let unqualifiedOwnerNamed = 0;

    for (const role of roles) {
      if (role.isDeleted) continue;
      const held = new Set(role.permissions);
      const ownerQualified = isSystemOwnerRole(role);
      const stampOwnerFlag = needsOwnerFlagStamp(role);
      const ownerFlagSkipped = isUnqualifiedOwnerNamed(role);
      const carriesRetiredPermission = LEGACY_PERMISSIONS.some((permission) => held.has(permission));
      const holdsRoute = held.has(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
      const holdsCancelClosed = held.has(PERMISSIONS.CANCEL_CLOSED_DEAL);
      if (carriesRetiredPermission) carriers += 1;
      if (stampOwnerFlag) unstampedOwners += 1;
      if (ownerFlagSkipped) unqualifiedOwnerNamed += 1;

      if (!carriesRetiredPermission && !stampOwnerFlag && !ownerFlagSkipped && !holdsRoute && !holdsCancelClosed) {
        continue;
      }

      records.push({
        roleId: role._id,
        orgId: role.orgId,
        name: role.name,
        ownerQualified,
        stampOwnerFlag,
        ownerFlagSkipped,
        carriesRetiredPermission,
        holdsRoute,
        holdsCancelClosed,
      });
    }

    return {
      ready: carriers === 0 && unstampedOwners === 0 && unqualifiedOwnerNamed === 0,
      retiredCarriers: carriers,
      unstampedOwners,
      unqualifiedOwnerNamed,
      records,
    };
  },
});
