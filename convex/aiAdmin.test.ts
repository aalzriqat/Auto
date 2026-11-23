// @vitest-environment node
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isAiDraftEnabledForOrg, sealProviderKey } from "./domains/ai";
import { expectAppError } from "../test-utils/expectAppError";

const FAKE_KEY = "sk-ant-test-FAKE-0000000000000000";
const FAKE_KEY_2 = "sk-ant-test-FAKE-1111111111111111";
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
const ORIGINAL_MASTER = process.env.AI_KEY_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  process.env.AI_KEY_ENCRYPTION_KEY = MASTER_KEY;
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  if (ORIGINAL_MASTER === undefined) delete process.env.AI_KEY_ENCRYPTION_KEY;
  else process.env.AI_KEY_ENCRYPTION_KEY = ORIGINAL_MASTER;
});

type T = ReturnType<typeof convexTestWithComponents>;
const newT = (): T => convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

async function seed(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", { clerkId: "admin_1", email: "admin@autoflow.dev" });
    await ctx.db.insert("users", { clerkId: "member_1", email: "member@dealership.com" });
  });
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() })
  );
  return {
    orgId,
    admin: t.withIdentity({ subject: "admin_1" }),
    member: t.withIdentity({ subject: "member_1" }),
  };
}

async function auditText(t: T): Promise<string> {
  return JSON.stringify(await t.run((ctx) => ctx.db.query("adminAuditLog").take(200)));
}

async function keyRows(t: T) {
  return t.run((ctx) => ctx.db.query("aiProviderKeys").take(10));
}

describe("T1 authorization on the six public functions", () => {
  test("unauthenticated and ordinary users are refused and nothing changes", async () => {
    const t = newT();
    const { orgId, member } = await seed(t);
    const refusals = [
      [t, "UNAUTHENTICATED", "Unauthenticated: You must be logged in."],
      [member, "FORBIDDEN", "Forbidden: Super-admin access only."],
    ] as const;
    for (const [caller, code, message] of refusals) {
      const refused = (attempt: Promise<unknown>) => expectAppError(attempt, code, message);
      await refused(caller.query(api.aiAdmin.getAiControlState, {}));
      await refused(caller.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: true }));
      await refused(caller.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY }));
      await refused(caller.mutation(api.aiAdmin.removeProviderKey, { provider: "anthropic" }));
      await refused(caller.query(api.aiAdmin.getOrgAiSettings, { orgId }));
      await refused(caller.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true }));
    }
    expect(await keyRows(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("aiSettings").take(2))).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("aiOrgSettings").take(2))).toHaveLength(0);
  });
});

describe("T2 saved key is write-only", () => {
  test("state shows last4; no table row, return value or audit row exposes the secret", async () => {
    const t = newT();
    const { orgId, admin } = await seed(t);
    const saved = await admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY });
    await admin.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: true });
    await admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true });
    await admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY_2 });

    const state = await admin.query(api.aiAdmin.getAiControlState, {});
    expect(state.encryptionConfigured).toBe(true);
    expect(state.draftsEnabled).toBe(true);
    expect(state.providers).toEqual([
      { kind: "set", provider: "anthropic", last4: "1111", setAt: expect.any(Number) },
    ]);
    expect(state.enabledOrgs).toEqual([{ orgId, name: "Acme Motors" }]);
    expect(saved.last4).toBe("0000");

    const [row] = await keyRows(t);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(FAKE_KEY);
    expect(stored).not.toContain(FAKE_KEY_2);
    expect(row!.ciphertext).not.toBe(FAKE_KEY_2);

    const publicReturns = JSON.stringify([
      saved,
      state,
      await admin.query(api.aiAdmin.getOrgAiSettings, { orgId }),
    ]);
    const audit = await auditText(t);
    for (const text of [publicReturns, audit]) {
      for (const secret of [FAKE_KEY, FAKE_KEY_2, row!.ciphertext, row!.iv]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(audit).toContain("ai_provider_key.set");
    expect(audit).toContain("ai_provider_key.replace");
    expect(audit).toContain("ai_drafts.master_switch");
    expect(audit).toContain("ai_drafts.org_switch");
  });

  test("a malformed key is refused with a message that does not echo it", async () => {
    const t = newT();
    const { admin } = await seed(t);
    for (const bad of ["QZXSHORT9", "QZXHAS space-inside-0123456789", `QZX${"y".repeat(400)}`, "QZXLINE\nbreak-0123456789abcdef"]) {
      const error = await admin
        .action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: bad })
        .then(() => null, (e: unknown) => e);
      expect(error).not.toBeNull();
      expect(JSON.stringify(error) + String(error)).not.toContain("QZX");
      expect((error as { data?: { code?: string } }).data?.code).toBe("AI_KEY_FORMAT_INVALID");
    }
    expect(await keyRows(t)).toHaveLength(0);
  });
});

describe("T3 a malformed request never reaches argument validation", () => {
  // convex-test does not reproduce the platform's argument-validation message,
  // which prints the whole argument object (SCRUM-980 ADR; probe on a local
  // Convex 1.42.1 backend). This test pins the door's own refusal: the action
  // takes an unvalidated argument and refuses by hand with fixed text.
  test.each([
    ["missing provider", { apiKey: FAKE_KEY }],
    ["extra field", { provider: "anthropic", apiKey: FAKE_KEY, note: "x" }],
    ["provider openai", { provider: "openai", apiKey: FAKE_KEY }],
    ["apiKey a number", { provider: "anthropic", apiKey: 12345678901234567890 }],
  ])("%s: refused with a fixed code, nothing stored or audited, no key in the text", async (_label, request) => {
    const t = newT();
    const { admin } = await seed(t);
    const error = await admin.action(api.aiAdmin.saveProviderKey, request).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(JSON.stringify(error) + String(error)).not.toContain(FAKE_KEY);
    expect((error as { data?: { code?: string } }).data?.code).toBe("AI_KEY_FORMAT_INVALID");
    expect(await keyRows(t)).toHaveLength(0);
    expect(await auditText(t)).not.toContain("ai_provider_key");
  });
});

describe("T3b sealProviderKey refuses a non-object request", () => {
  // The platform and convex-test reject a non-object argument before the
  // handler runs, so these two shapes are pinned on the module function.
  test.each([
    ["null", null],
    ["a string", FAKE_KEY],
    ["an array", [FAKE_KEY]],
  ])("request %s: fixed refusal, no key in the text", async (_label, request) => {
    const error = await sealProviderKey(request).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(JSON.stringify(error) + String(error)).not.toContain(FAKE_KEY);
    expect((error as { data?: { code?: string } }).data?.code).toBe("AI_KEY_FORMAT_INVALID");
  });
});

describe("T4 master encryption key missing or malformed", () => {
  test.each([
    ["missing", undefined],
    ["not base64", "not base64 at all!!"],
    ["16 bytes", btoa(String.fromCharCode(...new Uint8Array(16).fill(1)))],
  ])("%s: save refused, nothing stored, encryptionConfigured false", async (_label, value) => {
    const t = newT();
    const { admin } = await seed(t);
    if (value === undefined) delete process.env.AI_KEY_ENCRYPTION_KEY;
    else process.env.AI_KEY_ENCRYPTION_KEY = value;
    const error = await admin
      .action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY })
      .then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(JSON.stringify(error) + String(error)).not.toContain(FAKE_KEY);
    expect((error as { data?: { code?: string } }).data?.code).toBe("AI_KEY_ENCRYPTION_NOT_CONFIGURED");
    expect(await keyRows(t)).toHaveLength(0);
    expect(await auditText(t)).not.toContain("ai_provider_key");
    const state = await admin.query(api.aiAdmin.getAiControlState, {});
    expect(state.encryptionConfigured).toBe(false);
    expect(state.providers[0]!.kind).toBe("unset");
  });
});

describe("T5 gate", () => {
  async function gate(t: T, orgId: Id<"organizations">) {
    return t.run((ctx) => isAiDraftEnabledForOrg(ctx, orgId));
  }

  test("off by default and true only when all three conditions hold", async () => {
    const t = newT();
    const { orgId, admin } = await seed(t);
    expect(await gate(t, orgId)).toBe(false);
    await admin.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: true });
    expect(await gate(t, orgId)).toBe(false);
    await admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true });
    expect(await gate(t, orgId)).toBe(false);
    await admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY });
    expect(await gate(t, orgId)).toBe(true);
  });

  test.each([
    ["master switch off", (a: Awaited<ReturnType<typeof seed>>) =>
      a.admin.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: false })],
    ["dealership switch off", (a: Awaited<ReturnType<typeof seed>>) =>
      a.admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId: a.orgId, enabled: false })],
    ["key removed", (a: Awaited<ReturnType<typeof seed>>) =>
      a.admin.mutation(api.aiAdmin.removeProviderKey, { provider: "anthropic" })],
  ])("negative control: %s gives false", async (_label, remove) => {
    const t = newT();
    const s = await seed(t);
    await s.admin.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: true });
    await s.admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId: s.orgId, enabled: true });
    await s.admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY });
    expect(await gate(t, s.orgId)).toBe(true);
    await remove(s);
    expect(await gate(t, s.orgId)).toBe(false);
  });
});

describe("T6 Data Browser cannot reach the key table", () => {
  test("aiProviderKeys is not browsable", async () => {
    const t = newT();
    const { admin } = await seed(t);
    await admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY });
    const [row] = await keyRows(t);
    const listed = JSON.stringify(await admin.query(api.adminData.listAdminTables, {}));
    expect(listed).not.toContain("aiProviderKeys");
    await expect(
      admin.query(api.adminData.adminGetRecord, { table: "aiProviderKeys", id: row!._id })
    ).rejects.toThrow();
    await expect(
      admin.mutation(api.adminData.adminHardDelete, { table: "aiProviderKeys", id: row!._id })
    ).rejects.toThrow();
    expect(await keyRows(t)).toHaveLength(1);
  });
});

describe("T7 organization deletion", () => {
  test("removes the dealership AI settings row", async () => {
    const t = newT();
    const { orgId, admin } = await seed(t);
    await admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true });
    const { requestId } = await admin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    for (let i = 0; i < 300; i += 1) {
      const request = await t.run((ctx) => ctx.db.get(requestId));
      if (request?.status !== "RUNNING") break;
      await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId });
    }
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("COMPLETED");
    const rows = await t.run((ctx) => ctx.db.query("aiOrgSettings").take(5));
    expect(rows).toHaveLength(0);
  });

  test("an organization already being deleted cannot gain a new AI row", async () => {
    const t = newT();
    const { orgId, admin } = await seed(t);
    await admin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Acme Motors" });
    await expect(
      admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true })
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("aiOrgSettings").take(5))).toHaveLength(0);
  });
});

describe("T8 removing the key", () => {
  test("status shows not set and the gate is false", async () => {
    const t = newT();
    const { orgId, admin } = await seed(t);
    await admin.mutation(api.aiAdmin.setAiDraftsEnabled, { enabled: true });
    await admin.mutation(api.aiAdmin.setOrgAiDraftsEnabled, { orgId, enabled: true });
    await admin.action(api.aiAdmin.saveProviderKey, { provider: "anthropic", apiKey: FAKE_KEY });
    await admin.mutation(api.aiAdmin.removeProviderKey, { provider: "anthropic" });
    const state = await admin.query(api.aiAdmin.getAiControlState, {});
    expect(state.providers).toEqual([{ kind: "unset", provider: "anthropic" }]);
    expect(await t.run((ctx) => isAiDraftEnabledForOrg(ctx, orgId))).toBe(false);
    expect(await keyRows(t)).toHaveLength(0);
    expect(await auditText(t)).toContain("ai_provider_key.remove");
  });
});

describe("T9 the internal store refuses an unsupported provider", () => {
  test("a sealed openai key stores nothing and writes no audit row", async () => {
    const t = newT();
    await seed(t);
    const adminId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("users").take(10);
      return rows.find((row) => row.clerkId === "admin_1")!._id;
    });
    const sealed = { provider: "openai" as const, ciphertext: "c", iv: "i", keyVersion: 1, last4: "abcd" };
    await expectAppError(
      t.mutation(internal.aiAdmin.storeProviderKey, { actorUserId: adminId, sealed }),
      "VALIDATION_FAILED",
      "This AI provider is not supported yet."
    );
    expect(await keyRows(t)).toHaveLength(0);
    expect(await auditText(t)).not.toContain("ai_provider_key");
  });
});
