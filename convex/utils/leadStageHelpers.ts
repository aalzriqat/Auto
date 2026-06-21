import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { LEAD_STAGES, LeadStage } from "../constants";

const stageIndex = (stage: LeadStage) => LEAD_STAGES.indexOf(stage);

/**
 * Moves a lead forward to `targetStage`, never backward and never once it's
 * WON/LOST — those are terminal and shouldn't be disturbed by automation.
 */
export async function advanceLeadStage(
  ctx: MutationCtx,
  args: { leadId: Id<"leads">; targetStage: LeadStage }
): Promise<void> {
  const lead = await ctx.db.get(args.leadId);
  if (!lead) return;
  if (lead.stage === "WON" || lead.stage === "LOST") return;
  if (stageIndex(lead.stage) >= stageIndex(args.targetStage)) return;

  await ctx.db.patch(args.leadId, { stage: args.targetStage });
}

/**
 * Fuzzy fallback for events that don't carry an explicit leadId (e.g. test
 * drives, which are logged from the vehicle detail page with no lead
 * context). Matches open leads for the customer that either have no vehicle
 * pinned yet or are pinned to this exact vehicle.
 */
export async function advanceLeadStageForCustomerVehicle(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    targetStage: LeadStage;
  }
): Promise<void> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
    .collect();

  for (const lead of leads) {
    if (lead.isDeleted) continue;
    if (lead.stage === "WON" || lead.stage === "LOST") continue;
    if (lead.vehicleId && lead.vehicleId !== args.vehicleId) continue;
    await advanceLeadStage(ctx, { leadId: lead._id, targetStage: args.targetStage });
  }
}
