import { vi } from "vitest";
import { convexTestWithComponents } from "./convexTest";
import type { Id } from "../convex/_generated/dataModel";
import { encryptProviderKey } from "../convex/domains/ai/keyCrypto";

export type AiTest = ReturnType<typeof convexTestWithComponents>;

export const FAKE_KEY = "sk-ant-test-FAKE-0000000000000000";
export const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

export interface Dealership {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  customerId: Id<"customers">;
  vehicleId: Id<"vehicles">;
  adminId: Id<"users">;
  /** Subject of the sales member (permission edit:leads). */
  subject: string;
}

/** Fake timers keep the scheduler quiet until `drain` runs it. */
export function pauseScheduler(): void {
  vi.useFakeTimers();
}

/**
 * Runs the jobs that are due now (the draft job) and waits for them. The
 * 120 s expiry stays queued, as it does while a real job is still running.
 */
export async function drain(t: AiTest): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

export async function seedDealership(
  t: AiTest,
  opts: { name?: string; subject?: string; orgSettings?: Record<string, unknown>; vehicle?: Record<string, unknown> } = {}
): Promise<Dealership> {
  const subject = opts.subject ?? "sales_1";
  const name = opts.name ?? "Acme Motors";
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name, createdAt: Date.now() });
    await ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { clerkId: subject, email: `${subject}@example.com`, name: "Sales" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
      dealershipName: name,
      dealershipAddress: "1 Main Street",
      instagramAccessToken: "ig_token_abc",
      instagramBusinessAccountId: "ig_biz_1",
      facebookPageAccessToken: "fb_token_abc",
      facebookPageId: "fb_page_1",
      ...opts.orgSettings,
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId,
      make: "BYD",
      model: "Qin L",
      year: 2025,
      mileage: 1200,
      color: "Black",
      fuelType: "Electric",
      transmission: "Automatic",
      sellingPrice: 25000,
      status: "AVAILABLE",
      ...opts.vehicle,
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: "Omer" });
    await ctx.db.insert("instagramEvents", {
      orgId,
      externalId: `ig_dm_${subject}`,
      kind: "dm",
      senderInstagramId: "ig_sender_1",
      customerId,
      vehicleId,
      text: "Is this car still available?",
    });
    const adminId = await ctx.db.insert("users", { clerkId: `admin_${subject}`, email: `admin_${subject}@autoflow.dev` });
    return { orgId, userId, customerId, vehicleId, adminId, subject };
  });
}

/** Master switch, dealership switch and an encrypted dummy key, as the admin screen would leave them. */
export async function switchOnAi(t: AiTest, d: Dealership, parts: { master?: boolean; org?: boolean; key?: boolean } = {}) {
  const sealed = await encryptProviderKey({ provider: "anthropic", plaintext: FAKE_KEY, masterKey: MASTER_KEY });
  await t.run(async (ctx) => {
    const now = Date.now();
    if (parts.master ?? true) await ctx.db.insert("aiSettings", { draftsEnabled: true, updatedAt: now, updatedBy: d.adminId });
    if (parts.org ?? true) {
      await ctx.db.insert("aiOrgSettings", { orgId: d.orgId, draftsEnabled: true, updatedAt: now, updatedBy: d.adminId });
    }
    if (parts.key ?? true) {
      await ctx.db.insert("aiProviderKeys", {
        provider: "anthropic",
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        keyVersion: sealed.keyVersion,
        last4: FAKE_KEY.slice(-4),
        setAt: now,
        setBy: d.adminId,
      });
    }
  });
}

export interface CapturedRequest {
  url: string;
  body: string;
  apiKeyHeader: string | null;
}

export const anthropicMessage = (text: string, stopReason = "end_turn"): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json", "x-should-retry": "false" } }
  );

export const anthropicError = (status: number): Response =>
  new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "SENTINEL_PROVIDER_TEXT" } }), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });

export interface Network {
  anthropic: CapturedRequest[];
  meta: CapturedRequest[];
}

/** Stubs global fetch, routing by host. Anthropic answers with `answer`; Meta posts succeed. */
export function stubNetwork(answer: () => Response | Promise<Response>): Network {
  const network: Network = { anthropic: [], meta: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = typeof init?.body === "string" ? init.body : "";
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const apiKeyHeader = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      if (url.includes("api.anthropic.com")) {
        network.anthropic.push({ url, body, apiKeyHeader });
        return answer();
      }
      if (url.includes("graph.facebook.com") || url.includes("graph.instagram.com")) {
        network.meta.push({ url, body, apiKeyHeader });
        return new Response(JSON.stringify({ message_id: "m_1" }), { status: 200 });
      }
      throw new Error("unexpected network call");
    })
  );
  return network;
}

export const draftReply = (text: string): Response => anthropicMessage(JSON.stringify({ outcome: "draft", text }));
