import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

async function seedUser(t: ReturnType<typeof convexTest>, clerkId: string) {
  await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
  return t.withIdentity({ subject: clerkId });
}

describe("mobilePushTokens", () => {
  test("register stores the caller's token; listForUser returns it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const asUser = await seedUser(t, "user1");

    await asUser.mutation(api.mobilePushTokens.register, { token: TOKEN_A, platform: "ANDROID", deviceName: "Pixel" });

    const userId = await t.run((ctx) =>
      ctx.db.query("users").withIndex("by_clerkId", (q) => q.eq("clerkId", "user1")).unique().then((u) => u!._id)
    );
    const tokens = await t.query(internal.mobilePushTokens.listForUser, { userId });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ token: TOKEN_A, platform: "ANDROID", deviceName: "Pixel" });
  });

  test("rejects a token that isn't an Expo push token", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const asUser = await seedUser(t, "user1");
    await expect(
      asUser.mutation(api.mobilePushTokens.register, { token: "not-a-real-token", platform: "ANDROID" })
    ).rejects.toThrow(/Expo push token/i);
  });

  test("re-registering the same device token moves it to the new user, no duplicate", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const asUser1 = await seedUser(t, "user1");
    const asUser2 = await seedUser(t, "user2");

    await asUser1.mutation(api.mobilePushTokens.register, { token: TOKEN_A, platform: "ANDROID" });
    await asUser2.mutation(api.mobilePushTokens.register, { token: TOKEN_A, platform: "ANDROID" });

    const all = await t.run((ctx) => ctx.db.query("mobilePushTokens").collect());
    expect(all).toHaveLength(1);
    const user2Id = await t.run((ctx) =>
      ctx.db.query("users").withIndex("by_clerkId", (q) => q.eq("clerkId", "user2")).unique().then((u) => u!._id)
    );
    expect(all[0].userId).toBe(user2Id);
  });

  test("remove deletes only the caller's own token", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const asUser1 = await seedUser(t, "user1");
    const asUser2 = await seedUser(t, "user2");
    await asUser1.mutation(api.mobilePushTokens.register, { token: TOKEN_A, platform: "ANDROID" });
    await asUser2.mutation(api.mobilePushTokens.register, { token: TOKEN_B, platform: "IOS" });

    // user2 cannot remove user1's token
    await asUser2.mutation(api.mobilePushTokens.remove, { token: TOKEN_A });
    expect(await t.run((ctx) => ctx.db.query("mobilePushTokens").collect())).toHaveLength(2);

    // user1 removes their own
    await asUser1.mutation(api.mobilePushTokens.remove, { token: TOKEN_A });
    const remaining = await t.run((ctx) => ctx.db.query("mobilePushTokens").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].token).toBe(TOKEN_B);
  });

  test("register requires authentication", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await expect(
      t.mutation(api.mobilePushTokens.register, { token: TOKEN_A, platform: "ANDROID" })
    ).rejects.toThrow();
  });
});
