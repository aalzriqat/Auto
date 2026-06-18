import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedUser(t: ReturnType<typeof convexTest>, clerkId: string, email: string) {
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId, email }));
  return t.withIdentity({ subject: clerkId });
}

describe("adminSupportAgents", () => {
  test("listSupportAgents/addSupportAgent are forbidden for non-super-admins", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asMember = await seedUser(t, "user_1", "member@dealership.com");
    await expect(asMember.query(api.adminSupportAgents.listSupportAgents, {})).rejects.toThrow();
    await expect(
      asMember.mutation(api.adminSupportAgents.addSupportAgent, { email: "agent@autoflow.dev" })
    ).rejects.toThrow();
  });

  test("addSupportAgent fails for an email with no users row yet", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asAdmin = await seedUser(t, "admin_1", "admin@autoflow.dev");
    await expect(
      asAdmin.mutation(api.adminSupportAgents.addSupportAgent, { email: "nobody@nowhere.com" })
    ).rejects.toThrow();
  });

  test("super admin can add, list, deactivate, and remove a support agent", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asAdmin = await seedUser(t, "admin_1", "admin@autoflow.dev");
    await seedUser(t, "agent_1", "agent@autoflow.dev");

    const agentId = await asAdmin.mutation(api.adminSupportAgents.addSupportAgent, {
      email: "agent@autoflow.dev",
    });

    let agents = await asAdmin.query(api.adminSupportAgents.listSupportAgents, {});
    expect(agents).toHaveLength(1);
    expect(agents[0]!.isActive).toBe(true);

    await asAdmin.mutation(api.adminSupportAgents.setSupportAgentActive, { agentId, isActive: false });
    agents = await asAdmin.query(api.adminSupportAgents.listSupportAgents, {});
    expect(agents[0]!.isActive).toBe(false);

    await asAdmin.mutation(api.adminSupportAgents.removeSupportAgent, { agentId });
    agents = await asAdmin.query(api.adminSupportAgents.listSupportAgents, {});
    expect(agents).toHaveLength(0);
  });

  test("addSupportAgent rejects a duplicate", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asAdmin = await seedUser(t, "admin_1", "admin@autoflow.dev");
    await seedUser(t, "agent_1", "agent@autoflow.dev");

    await asAdmin.mutation(api.adminSupportAgents.addSupportAgent, { email: "agent@autoflow.dev" });
    await expect(
      asAdmin.mutation(api.adminSupportAgents.addSupportAgent, { email: "agent@autoflow.dev" })
    ).rejects.toThrow();
  });
});
