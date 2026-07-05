import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Push Dealer", createdAt: Date.now() })
  );
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  const otherRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId: otherOrgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  const aliceId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "alice_push", email: "alice@test.com", name: "Alice" })
  );
  const eveId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "eve_push", email: "eve@test.com", name: "Eve" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: aliceId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: eveId, roleId: otherRoleId }));
  // Alice belongs to both orgs, so a same-browser subscribe from her should
  // be able to register push for either without disturbing the other.
  await t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: aliceId, roleId: otherRoleId }));

  const asAlice = t.withIdentity({ subject: "alice_push", clerkId: "alice_push" });
  const asEve = t.withIdentity({ subject: "eve_push", clerkId: "eve_push" });

  return { orgId, otherOrgId, aliceId, eveId, asAlice, asEve };
}

describe("pushSubscriptions", () => {
  test("subscribe creates one device row", async () => {
    const { orgId, asAlice } = await setup();

    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
      userAgent: "Chrome/Windows",
    });

    const devices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    expect(devices).toHaveLength(1);
    expect(devices[0].userAgent).toBe("Chrome/Windows");
    expect(devices[0].enabled).toBe(true);
  });

  test("re-subscribing the same endpoint updates the row instead of duplicating it", async () => {
    const { orgId, asAlice } = await setup();

    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
    });
    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key2-rotated",
      auth: "auth2-rotated",
    });

    const devices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    expect(devices).toHaveLength(1);
  });

  test("unsubscribe removes the device", async () => {
    const { orgId, asAlice } = await setup();

    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
    });
    await asAlice.mutation(api.pushSubscriptions.unsubscribe, {
      orgId,
      endpoint: "https://push.example/abc",
    });

    const devices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    expect(devices).toHaveLength(0);
  });

  test("disableDevice turns a device off without deleting it", async () => {
    const { orgId, asAlice } = await setup();

    const subscriptionId = await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
    });
    await asAlice.mutation(api.pushSubscriptions.disableDevice, { orgId, subscriptionId });

    const devices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    expect(devices).toHaveLength(1);
    expect(devices[0].enabled).toBe(false);
  });

  test("subscribing the same browser endpoint under a second org adds a row instead of stealing the first", async () => {
    const { orgId, otherOrgId, asAlice } = await setup();
    const sharedEndpoint = "https://push.example/shared-browser";

    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: sharedEndpoint,
      p256dh: "key1",
      auth: "auth1",
    });
    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId: otherOrgId,
      endpoint: sharedEndpoint,
      p256dh: "key1",
      auth: "auth1",
    });

    const firstOrgDevices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    const secondOrgDevices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId: otherOrgId });
    expect(firstOrgDevices).toHaveLength(1);
    expect(secondOrgDevices).toHaveLength(1);

    // Unsubscribing from one org's registration must not remove the other's.
    await asAlice.mutation(api.pushSubscriptions.unsubscribe, { orgId, endpoint: sharedEndpoint });
    expect(await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId })).toHaveLength(0);
    expect(await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId: otherOrgId })).toHaveLength(1);
  });

  test("removeByEndpoint (dead-endpoint cleanup) purges every org's row for that endpoint", async () => {
    const { orgId, otherOrgId, asAlice } = await setup();
    const sharedEndpoint = "https://push.example/shared-browser-2";

    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: sharedEndpoint,
      p256dh: "key1",
      auth: "auth1",
    });
    await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId: otherOrgId,
      endpoint: sharedEndpoint,
      p256dh: "key1",
      auth: "auth1",
    });

    await asAlice.mutation(internal.pushSubscriptions.removeByEndpoint, { endpoint: sharedEndpoint });

    expect(await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId })).toHaveLength(0);
    expect(await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId: otherOrgId })).toHaveLength(0);
  });

  test("a user cannot disable another org's device even if they guess the subscription id", async () => {
    const { orgId, asAlice, asEve } = await setup();

    const subscriptionId = await asAlice.mutation(api.pushSubscriptions.subscribe, {
      orgId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
    });

    // Eve isn't a member of `orgId` at all, so requireTenantAuth rejects her outright.
    await expect(
      asEve.mutation(api.pushSubscriptions.disableDevice, { orgId, subscriptionId })
    ).rejects.toThrow();

    const devices = await asAlice.query(api.pushSubscriptions.listMyDevices, { orgId });
    expect(devices[0].enabled).toBe(true);
  });
});
