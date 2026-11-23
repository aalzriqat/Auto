import { openingDatabase, type OpeningReadCtx } from "../utils/openingSourceIdentity";
import { ConvexError } from "convex/values";
import { type Id } from "../_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "../_generated/server";
import { type SystemKey, SYSTEM_KEYS } from "../utils/defaultChart";

// ─── Internal helpers ─────────────────────────────────────────────────────────
export async function resolveSystemAccount(
  ctx: OpeningReadCtx | MutationCtx,
  orgId: Id<"organizations">,
  systemKey: SystemKey
): Promise<Id<"chartOfAccounts">> {
  // .collect(), not .unique(): this runs on every posting for the org, and a
  // pre-existing org (from before ensureSystemAccount started guarding against
  // duplicate systemKey rows) may still carry more than one row from the old
  // blind self-heal. A hot posting path must never hard-crash on dirty legacy
  // data — deterministically pick the earliest-created ACTIVE row (the
  // original mapping) so every posting keeps resolving to the same account
  // instead of failing or picking randomly. The duplicate itself still needs
  // a one-time cleanup, but that's a data-hygiene task, not a reason to block
  // every future posting until someone gets to it.
  const accounts = await openingDatabase(ctx)
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .collect();
  if (accounts.length === 0) {
    throw new ConvexError(
      `System account "${systemKey}" is not mapped for this organization. Initialize the chart of accounts first.`
    );
  }
  const active = accounts.filter((a) => a.active);
  const candidates = active.length > 0 ? active : accounts;
  const account = candidates.reduce((oldest, a) => (a._creationTime < oldest._creationTime ? a : oldest), candidates[0]);
  if (!account.active) {
    throw new ConvexError(`System account "${systemKey}" is inactive.`);
  }
  return account._id;
}

export async function isChartInitialized(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<boolean> {
  const first = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  return first !== null;
}

/**
 * Is one system key resolvable for this org RIGHT NOW — read-only, never
 * creating, adopting or reclassifying anything (SCRUM-218-C).
 *
 * `isChartInitialized` above answers "does this org have a chart at all", which
 * is what `shouldPost` uses. That is too coarse for an event whose journal needs
 * a SPECIFIC account: an org with a chart but without 2110 passes
 * `isChartInitialized`, posts synchronously, and `resolveSystemAccount` then
 * throws INSIDE the receipt transaction. Because nothing catches it, Convex
 * rolls back the confirmed receipt — the money the customer actually handed over
 * disappears because a chart account was missing. That failure is not
 * hypothetical; it is the CRITICAL that ended SCRUM-218's round-3 design.
 *
 * So this exists to let a producer ask the narrow question BEFORE choosing to
 * post, and enqueue instead when the answer is no.
 *
 * Mirrors `resolveSystemAccount`'s liveness rule exactly — a row must exist AND
 * at least one must be active — because a check that is laxer than the resolver
 * it guards would send the event down the synchronous path to throw anyway.
 * Deliberately does NOT reuse the earliest-created tie-break: this answers
 * "would resolution succeed", not "which row wins".
 */
export async function isSystemAccountMapped(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  systemKey: SystemKey
): Promise<boolean> {
  const accounts = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .collect();
  return accounts.some((a) => a.active);
}

/** The custody accounts the self-heal above inserts, with their reserved codes. */
export const DEAL_CUSTODY_ACCOUNT_CODES = [
  [SYSTEM_KEYS.DEAL_CUSTODY_CLEARING, "1250"],
  [SYSTEM_KEYS.EMPLOYEE_REIMBURSEMENTS_PAYABLE, "2320"],
  [SYSTEM_KEYS.CASH_OVER_SHORT, "6200"],
] as const;

/**
 * Whether a custody posting COULD resolve its accounts on this org — the
 * read-only twin of `ensureDealCustodyAccounts`, for a screen that has to
 * say WHY a money button is disabled rather than let a mutation find out.
 *
 * Mirrors the self-heal's own decision: a mapped key resolves; an unmapped
 * key resolves iff its default code is free (the self-heal will insert it)
 * or already carries the key; any other occupant of the code is a conflict a
 * human resolves. Never writes.
 */
export async function dealCustodyAccountingReadiness(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<
  | { ready: true }
  | { ready: false; reason: "CHART_NOT_INITIALIZED" | "ACCOUNT_UNMAPPED" | "ACCOUNT_CODE_CONFLICT"; systemKey?: SystemKey }
> {
  if (!(await isChartInitialized(ctx, orgId))) return { ready: false, reason: "CHART_NOT_INITIALIZED" };
  for (const key of [SYSTEM_KEYS.CASH_ON_HAND, SYSTEM_KEYS.BANK_ACCOUNT] as const) {
    if (!(await isSystemAccountMapped(ctx, orgId, key))) return { ready: false, reason: "ACCOUNT_UNMAPPED", systemKey: key };
  }
  for (const [key, code] of DEAL_CUSTODY_ACCOUNT_CODES) {
    if (await isSystemAccountMapped(ctx, orgId, key)) continue;
    // Bounded, fail-closed: one row on the code is enough to know the
    // self-heal could not insert there. Codes are unique per org by the
    // `create` mutation, so a second row would itself be corruption — and a
    // chart that corrupt is not one this probe should call ready.
    const onCode = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_code", (q) => q.eq("orgId", orgId).eq("code", code))
      .take(2);
    if (onCode.length === 0) continue;
    // The key's own row exists but is INACTIVE (or the code is duplicated):
    // `resolveSystemAccount` would refuse it and the self-heal would not
    // replace it.
    if (onCode.length > 1 || onCode[0].systemKey === key) {
      return { ready: false, reason: "ACCOUNT_UNMAPPED", systemKey: key };
    }
    return { ready: false, reason: "ACCOUNT_CODE_CONFLICT", systemKey: key };
  }
  return { ready: true };
}
