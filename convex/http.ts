import { ConvexError } from "convex/values";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Webhook } from "svix";
import { getValidatedEnv } from "./utils/env";

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let webhookSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.CLERK_WEBHOOK_SECRET) throw new ConvexError("CLERK_WEBHOOK_SECRET not set");
      webhookSecret = env.CLERK_WEBHOOK_SECRET;
    } catch (e) {
      console.error(e);
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();
    const wh = new Webhook(webhookSecret);

    let event: any;
    try {
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (err) {
      console.error("Error verifying Clerk webhook signature:", err);
      return new Response("Invalid signature", { status: 400 });
    }

    const { type, data } = event;

    switch (type) {
      case "user.created":
      case "user.updated": {
        const email = data.email_addresses?.[0]?.email_address ?? "";
        const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
        const imageUrl = data.image_url ?? "";

        await ctx.runMutation(internal.users.updateOrCreateUser, {
          clerkId: data.id,
          email,
          name: name || undefined,
          imageUrl: imageUrl || undefined,
        });
        break;
      }
      case "user.deleted": {
        if (data.id) {
          await ctx.runMutation(internal.users.deleteUser, {
            clerkId: data.id,
          });
        }
        break;
      }
      default:
        console.log(`Unhandled Clerk webhook event type: ${type}`);
    }

    return new Response(null, { status: 200 });
  }),
});

export default http;
