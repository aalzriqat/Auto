import { expect } from "vitest";
import { makeFunctionReference } from "convex/server";
import { mutation } from "../convex/functions";
import { v } from "convex/values";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { snapshot, post, fbDm, igDm, PROD_LIKE_FB, PROD_LIKE_IG, type T } from "./socialWebhook";

export type Platform = "facebook" | "instagram";
export async function signed(t: T, orgId: Id<"organizations">, platform: Platform, sender: string, text: string, expected?: string) {
  await t.runUnwrapped(async (ctx) => {
    for (const settings of await ctx.db.query("orgSettings").collect()) {
      await ctx.db.patch(settings._id, { facebookPageId: undefined, instagramWebhookAccountId: undefined, instagramBusinessAccountId: undefined });
      if (settings.orgId === orgId) await ctx.db.patch(settings._id, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    }
  });
  const response = platform === "facebook"
    ? await post(t, "/facebook-webhook", fbDm(sender, text))
    : await post(t, "/instagram-webhook", igDm(sender, text));
  expect(response.status).toBe(200);
  const state = await snapshot(t, orgId);
  const customer = state.customers.find((row) => platform === "facebook" ? row.facebookUserId === sender : row.instagramUserId === sender);
  expect(customer, "signed intake must reach the receiving organization").toBeDefined();
  expect(customer?.phone).toBe(expected);
}

export async function wrappedWrite(t: T, write: (ctx: MutationCtx) => Promise<unknown>) {
  const registered = mutation({ args: {}, returns: v.null(), handler: async (ctx) => { await write(ctx); return null; } });
  if (!("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Installed mutation handler unavailable");
  const handler = registered._handler;
  await t.mutation(async (ctx) => { await handler(ctx, {}); });
}

export async function completeBootstrap(t: T) {
  const rebuild = makeFunctionReference<"mutation", Record<string, never>, { done: boolean }>("socialOwnNumberMigration:rebuildPage");
  for (let page = 0; page < 100; page++) {
    if ((await t.mutation(rebuild, {})).done) return;
  }
  throw new Error("Synthetic bootstrap did not terminate");
}
