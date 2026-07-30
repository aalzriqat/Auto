import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Append-only audit trail for leads (schema: `leadActivities`).
 *
 * Every mutation that touches a lead funnels through here so the timeline has
 * no holes — including the ones with no signed-in caller (social webhooks,
 * marketplace conversions, stage advances fired by a test drive or a completed
 * sale), which pass `actorLabel` instead of `actorUserId`.
 *
 * Rows are written, never updated or deleted. A soft delete appends a DELETED
 * row rather than removing history, so a restored lead keeps its full past.
 */

export type LeadActivityAction =
  | "CREATED"
  | "STAGE_CHANGED"
  | "ASSIGNED"
  | "UNASSIGNED"
  | "UPDATED"
  | "DELETED"
  | "RESTORED"
  | "NOTE";

/** Fields worth auditing, in the order they should read in the timeline. */
const AUDITED_FIELDS = [
  "stage",
  "assignedUserId",
  "customerId",
  "vehicleId",
  "source",
  "notes",
] as const;

export type AuditedLeadField = (typeof AUDITED_FIELDS)[number];

/** Field values only need enough to compare a before against an after. */
const MAX_VALUE_LENGTH = 300;

/**
 * A salesperson's own update is the content, not a summary of it — give it
 * real room. Still bounded, so one row can't be used to store a document.
 */
export const MAX_NOTE_LENGTH = 2000;

function truncate(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function actionForField(field: AuditedLeadField, toValue: unknown): LeadActivityAction {
  if (field === "stage") return "STAGE_CHANGED";
  if (field === "assignedUserId") return toValue ? "ASSIGNED" : "UNASSIGNED";
  return "UPDATED";
}

/**
 * Renders a lead field value into the display string stored on the audit row.
 *
 * Resolving ids to names at write time (rather than at read time) is
 * deliberate: it keeps the timeline query free of fan-out lookups, and it
 * preserves what the value *was* even after the customer is merged away or the
 * vehicle is deleted. Dangling ids degrade to a readable placeholder rather
 * than throwing — an audit write must never be the thing that fails a
 * mutation, since a throw would roll back the business write it was recording.
 */
export async function describeLeadFieldValue(
  ctx: MutationCtx,
  field: AuditedLeadField,
  value: unknown
): Promise<string | undefined> {
  if (value === undefined || value === null || value === "") return undefined;

  switch (field) {
    case "customerId": {
      const customer = await ctx.db.get(value as Id<"customers">);
      return customer ? truncate(`${customer.firstName} ${customer.lastName}`.trim()) : "Unknown customer";
    }
    case "vehicleId": {
      const vehicle = await ctx.db.get(value as Id<"vehicles">);
      return vehicle ? truncate(`${vehicle.year} ${vehicle.make} ${vehicle.model}`) : "Unknown vehicle";
    }
    case "assignedUserId": {
      const user = await ctx.db.get(value as Id<"users">);
      return user ? truncate(user.name || user.email || "Unnamed user") : "Unknown user";
    }
    default:
      return truncate(String(value));
  }
}

/**
 * Inserts one audit row. `orgId` is taken from the caller rather than re-read
 * off the lead so this stays usable from creation paths, where the row is
 * already in hand.
 */
export async function recordLeadActivity(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    leadId: Id<"leads">;
    action: LeadActivityAction;
    actorUserId?: Id<"users">;
    actorLabel?: string;
    field?: string;
    fromValue?: string;
    toValue?: string;
    note?: string;
  }
): Promise<void> {
  await ctx.db.insert("leadActivities", {
    orgId: args.orgId,
    leadId: args.leadId,
    actorUserId: args.actorUserId,
    actorLabel: args.actorUserId ? undefined : (args.actorLabel ?? "System"),
    action: args.action,
    field: args.field,
    fromValue: args.fromValue,
    toValue: args.toValue,
    note: args.note ? truncate(args.note, MAX_NOTE_LENGTH) : undefined,
    createdAt: Date.now(),
  });
}

/**
 * Records a lead's creation, including who it landed on. The ASSIGNED row is
 * emitted separately from CREATED so "leads assigned to me" reads the same
 * whether the assignment happened at creation or later.
 */
export async function recordLeadCreated(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    leadId: Id<"leads">;
    actorUserId?: Id<"users">;
    actorLabel?: string;
    stage: string;
    assignedUserId?: Id<"users">;
    source?: string;
  }
): Promise<void> {
  await recordLeadActivity(ctx, {
    orgId: args.orgId,
    leadId: args.leadId,
    action: "CREATED",
    actorUserId: args.actorUserId,
    actorLabel: args.actorLabel,
    field: "stage",
    toValue: args.stage,
    note: args.source,
  });

  if (args.assignedUserId) {
    await recordLeadActivity(ctx, {
      orgId: args.orgId,
      leadId: args.leadId,
      action: "ASSIGNED",
      actorUserId: args.actorUserId,
      actorLabel: args.actorLabel,
      field: "assignedUserId",
      toValue: await describeLeadFieldValue(ctx, "assignedUserId", args.assignedUserId),
    });
  }
}

/**
 * Diffs a patch against the lead as it was and appends one row per field that
 * actually moved. Call this *before* `ctx.db.patch`, while `before` still
 * holds the old values.
 *
 * Returns the number of rows written, so callers can tell a real edit from a
 * no-op save (the leads dialog re-submits every field on every save).
 */
export async function recordLeadFieldChanges(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    leadId: Id<"leads">;
    before: Doc<"leads">;
    patch: Record<string, unknown>;
    actorUserId?: Id<"users">;
    actorLabel?: string;
  }
): Promise<number> {
  let written = 0;

  for (const field of AUDITED_FIELDS) {
    if (!(field in args.patch)) continue;

    const nextRaw = args.patch[field];
    const prevRaw = args.before[field];

    // Normalize so an absent field and an empty one compare equal — the form
    // sends `undefined` for a cleared dropdown, the row may hold `undefined`
    // or "" depending on how it was created.
    const prevKey = prevRaw ?? "";
    const nextKey = nextRaw ?? "";
    if (prevKey === nextKey) continue;

    await recordLeadActivity(ctx, {
      orgId: args.orgId,
      leadId: args.leadId,
      action: actionForField(field, nextRaw),
      actorUserId: args.actorUserId,
      actorLabel: args.actorLabel,
      field,
      fromValue: await describeLeadFieldValue(ctx, field, prevRaw),
      toValue: await describeLeadFieldValue(ctx, field, nextRaw),
    });
    written += 1;
  }

  return written;
}
