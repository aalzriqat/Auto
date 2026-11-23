import { v } from "convex/values";

/**
 * SCRUM-868 P3 round 2: the audit stamp the release repair writes when it gives a row written before supplier
 * ids existed its `supplierId`. Optional in storage forever (every other row never has it). It records HOW the
 * id was found: always the vehicle's frozen supplier link, never a name; the name only corroborated it.
 */
export const supplierIdentityRepairStamp = v.object({
  at: v.number(),
  source: v.literal("VEHICLE_LINK"),
  nameMatchedOn: v.union(v.literal("DISPLAY_NAME"), v.literal("ALIAS")),
});
