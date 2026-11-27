// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { withFrozenScheduler } from "../test-utils/outboxWork";
import { codeOf, dismissReclass, requestArgs, requestReclass, seedPrepaidReclass, type Seed } from "../test-utils/prepaidReclassificationFixture";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/** SCRUM-961 review round 1, M2: who may dismiss a pending request. */
async function seed(): Promise<Seed> {
  await import("./accountingOutbox");
  return seedPrepaidReclass(convexTestWithComponents(schema, import.meta.glob("./**/*.*s")));
}async function pendingRequest(s: Seed) {
  const { reclassificationId } = await s.preparer.mutation(requestReclass, requestArgs(s));
  return { orgId: s.orgId, reclassificationId: reclassificationId as never };
}
async function statusOf(s: Seed, args: { reclassificationId: never }) {
  return s.t.run((ctx) => ctx.db.get(args.reclassificationId as Id<"openingPrepaidReclassifications">).then((row) => row?.status));
}
test("dismiss: a person named in the request cannot dismiss it", () => withFrozenScheduler(async () => {
  const s = await seed();
  const args = await pendingRequest(s);
  expect(await codeOf(s.first.mutation(dismissReclass, args))).toBe("PREPAID_RECLASS_BENEFICIARY");
  expect(await statusOf(s, args)).toBe("PENDING");
}));
test("dismiss: a support session is refused and writes nothing", () => withFrozenScheduler(async () => {
  const s = await seed();
  const args = await pendingRequest(s);
  await s.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").collect()).find((row) => row.orgId === s.orgId && row.userId === s.reviewerId);
    if (!membership) throw new Error("Missing membership");
    const grantId = await ctx.db.insert("impersonationGrants", { actorUserId: s.reviewerId, targetUserId: s.ownerId, orgId: s.orgId,
      membershipId: membership._id, reason: "Synthetic support session", grantedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await ctx.db.patch(membership._id, { impersonationGrantId: grantId });
  });
  expect(await codeOf(s.reviewer.mutation(dismissReclass, args))).toBe("PREPAID_RECLASS_AUTHORITY");
  expect(await statusOf(s, args)).toBe("PENDING");
}));
test("dismiss twin: the requester and another authorised non-beneficiary both can", () => withFrozenScheduler(async () => {
  const s = await seed();
  const mine = await pendingRequest(s);
  expect(await codeOf(s.preparer.mutation(dismissReclass, mine))).toBeUndefined();
  expect(await statusOf(s, mine)).toBe("DISMISSED");
  const theirs = await pendingRequest(s);
  expect(await codeOf(s.reviewer.mutation(dismissReclass, theirs))).toBeUndefined();
  expect(await statusOf(s, theirs)).toBe("DISMISSED");
}));