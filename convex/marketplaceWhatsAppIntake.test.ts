import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { computeNextIntakeState, promptForStep, IntakeState } from "./marketplaceWhatsAppIntake";

type IntakeMessageInput =
  | { kind: "text"; text: string }
  | { kind: "button"; buttonId: string }
  | { kind: "image"; mediaId: string };

const ORIGINAL_ENV = {
  PHONE_NUMBER_ID: process.env.MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID,
  API_TOKEN: process.env.MARKETPLACE_WHATSAPP_API_TOKEN,
  CLERK: process.env.CLERK_JWT_ISSUER_DOMAIN,
  APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID = "test-phone-number-id";
  process.env.MARKETPLACE_WHATSAPP_API_TOKEN = "test-api-token";
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com";
});

afterEach(() => {
  restoreEnv("MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID", ORIGINAL_ENV.PHONE_NUMBER_ID);
  restoreEnv("MARKETPLACE_WHATSAPP_API_TOKEN", ORIGINAL_ENV.API_TOKEN);
  restoreEnv("CLERK_JWT_ISSUER_DOMAIN", ORIGINAL_ENV.CLERK);
  restoreEnv("NEXT_PUBLIC_APP_URL", ORIGINAL_ENV.APP_URL);
  vi.unstubAllGlobals();
});

// ─── Pure state machine ────────────────────────────────────────────────────

describe("computeNextIntakeState", () => {
  const fresh: IntakeState = { step: "AWAITING_MAKE", photoCount: 0 };

  test("walks make -> model -> year -> mileage -> price -> photos on valid text replies", () => {
    let state = fresh;
    state = computeNextIntakeState(state, { kind: "text", text: "Toyota" }).state;
    expect(state).toMatchObject({ step: "AWAITING_MODEL", make: "Toyota" });

    state = computeNextIntakeState(state, { kind: "text", text: "Corolla" }).state;
    expect(state).toMatchObject({ step: "AWAITING_YEAR", model: "Corolla" });

    state = computeNextIntakeState(state, { kind: "text", text: "2020" }).state;
    expect(state).toMatchObject({ step: "AWAITING_MILEAGE", year: 2020 });

    state = computeNextIntakeState(state, { kind: "text", text: "50,000" }).state;
    expect(state).toMatchObject({ step: "AWAITING_PRICE", mileage: 50000 });

    state = computeNextIntakeState(state, { kind: "text", text: "12000" }).state;
    expect(state).toMatchObject({ step: "AWAITING_PHOTOS", sellingPrice: 12000 });
  });

  test("rejects an out-of-range year and stays on AWAITING_YEAR", () => {
    const state: IntakeState = { step: "AWAITING_YEAR", make: "Toyota", model: "Corolla", photoCount: 0 };
    const result = computeNextIntakeState(state, { kind: "text", text: "1899" });
    expect(result.state.step).toBe("AWAITING_YEAR");
    expect(result.reply.kind).toBe("text");
    if (result.reply.kind === "text") expect(result.reply.text).toMatch(/valid year/);
  });

  test("rejects a non-numeric mileage and stays on AWAITING_MILEAGE", () => {
    const state: IntakeState = { step: "AWAITING_MILEAGE", photoCount: 0 };
    const result = computeNextIntakeState(state, { kind: "text", text: "a lot" });
    expect(result.state.step).toBe("AWAITING_MILEAGE");
  });

  test("rejects a zero/negative price and stays on AWAITING_PRICE", () => {
    const state: IntakeState = { step: "AWAITING_PRICE", photoCount: 0 };
    expect(computeNextIntakeState(state, { kind: "text", text: "0" }).state.step).toBe("AWAITING_PRICE");
    expect(computeNextIntakeState(state, { kind: "text", text: "-5" }).state.step).toBe("AWAITING_PRICE");
  });

  test("AWAITING_PHOTOS: DONE with zero photos is rejected; DONE with photos advances to AWAITING_CONFIRM", () => {
    const zeroPhotos: IntakeState = { step: "AWAITING_PHOTOS", photoCount: 0 };
    expect(computeNextIntakeState(zeroPhotos, { kind: "text", text: "DONE" }).state.step).toBe("AWAITING_PHOTOS");

    const withPhotos: IntakeState = { step: "AWAITING_PHOTOS", photoCount: 2 };
    const result = computeNextIntakeState(withPhotos, { kind: "text", text: "done" });
    expect(result.state.step).toBe("AWAITING_CONFIRM");
    expect(result.reply.kind).toBe("buttons");
  });

  test("AWAITING_PHOTOS: an image re-shows the same prompt (caller updates photoCount before calling)", () => {
    const state: IntakeState = { step: "AWAITING_PHOTOS", photoCount: 1 };
    const result = computeNextIntakeState(state, { kind: "image" });
    expect(result.state.step).toBe("AWAITING_PHOTOS");
  });

  test("AWAITING_CONFIRM accepts both a button tap and the typed word, for both CONFIRM and CANCEL", () => {
    const confirmState: IntakeState = { step: "AWAITING_CONFIRM", make: "Toyota", model: "Corolla", year: 2020, mileage: 1000, sellingPrice: 9000, photoCount: 1 };
    expect(computeNextIntakeState(confirmState, { kind: "button", buttonId: "MARKETPLACE_INTAKE_CONFIRM" }).state.step).toBe("COMPLETED");
    expect(computeNextIntakeState(confirmState, { kind: "text", text: "confirm" }).state.step).toBe("COMPLETED");
    expect(computeNextIntakeState(confirmState, { kind: "button", buttonId: "MARKETPLACE_INTAKE_CANCEL" }).state.step).toBe("CANCELLED");
    expect(computeNextIntakeState(confirmState, { kind: "text", text: "cancel" }).state.step).toBe("CANCELLED");
  });

  test("an unrecognized confirm-step reply re-shows the confirm buttons instead of advancing", () => {
    const confirmState: IntakeState = { step: "AWAITING_CONFIRM", photoCount: 1 };
    const result = computeNextIntakeState(confirmState, { kind: "text", text: "maybe" });
    expect(result.state.step).toBe("AWAITING_CONFIRM");
    expect(result.reply.kind).toBe("buttons");
  });

  test("CANCEL is accepted from any non-terminal step, mid-flow", () => {
    const midFlow: IntakeState = { step: "AWAITING_MILEAGE", make: "Toyota", model: "Corolla", year: 2020, photoCount: 0 };
    const result = computeNextIntakeState(midFlow, { kind: "text", text: "CANCEL" });
    expect(result.state.step).toBe("CANCELLED");
  });

  test("a terminal step never advances further — caller is responsible for starting a fresh flow", () => {
    const done: IntakeState = { step: "COMPLETED", photoCount: 1 };
    expect(computeNextIntakeState(done, { kind: "text", text: "anything" }).state.step).toBe("COMPLETED");
    const cancelled: IntakeState = { step: "CANCELLED", photoCount: 0 };
    expect(computeNextIntakeState(cancelled, { kind: "text", text: "anything" }).state.step).toBe("CANCELLED");
  });

  test("an image reply on a text-expecting step is rejected with a re-prompt, not silently accepted", () => {
    const state: IntakeState = { step: "AWAITING_MAKE", photoCount: 0 };
    const result = computeNextIntakeState(state, { kind: "image" });
    expect(result.state.step).toBe("AWAITING_MAKE");
    expect(result.state.make).toBeUndefined();
  });
});

describe("promptForStep", () => {
  test("AWAITING_CONFIRM produces a buttons reply with Confirm/Cancel", () => {
    const state: IntakeState = { step: "AWAITING_CONFIRM", make: "Toyota", model: "Corolla", year: 2020, mileage: 1000, sellingPrice: 9000, photoCount: 2 };
    const reply = promptForStep(state);
    expect(reply.kind).toBe("buttons");
    if (reply.kind === "buttons") {
      expect(reply.buttons.map((b) => b.id)).toEqual(["MARKETPLACE_INTAKE_CONFIRM", "MARKETPLACE_INTAKE_CANCEL"]);
    }
  });
});

// ─── End-to-end via the internalAction ─────────────────────────────────────

async function seedOptedInDealer(t: ReturnType<typeof convexTest>, whatsappNumber: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "WhatsApp Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
      whatsappNumber,
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  return { orgId, userId };
}

function stubFetchForIntake() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("/messages")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === "https://fake-media-url.example.com/photo.jpg") {
        return new Response(new Blob(["fake-photo-bytes"], { type: "image/jpeg" }), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // Media metadata lookup: graph.facebook.com/{version}/{mediaId}
      return new Response(JSON.stringify({ url: "https://fake-media-url.example.com/photo.jpg" }), { status: 200 });
    })
  );
}

describe("handleIntakeMessage", () => {
  test("no-ops without throwing when platform WhatsApp credentials are unset", async () => {
    delete process.env.MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.MARKETPLACE_WHATSAPP_API_TOKEN;
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));

    await expect(
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, {
        phone: "962791234567",
        input: { kind: "text", text: "hi" },
      })
    ).resolves.not.toThrow();

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows).toHaveLength(0);
  });

  test("an unregistered phone number gets a not-registered reply and no flow is created", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));

    await t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, {
      phone: "962799999999",
      input: { kind: "text", text: "hi" },
    });

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("the first message from an opted-in dealer starts a fresh flow without consuming it as data", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedOptedInDealer(t, "+962 79 123 4567");

    await t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, {
      phone: "962791234567",
      input: { kind: "text", text: "Hello!" },
    });

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows).toHaveLength(1);
    expect(flows[0].step).toBe("AWAITING_MAKE");
    expect(flows[0].make).toBeUndefined();
  });

  test("full happy path: collects every field + a photo, confirms, and creates a PENDING vehicleEdits CREATE — not a live vehicle", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedOptedInDealer(t, "962791234567");
    const phone = "962791234567";
    const run = (input: IntakeMessageInput) =>
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, { phone, input });

    await run({ kind: "text", text: "start" }); // fresh flow
    await run({ kind: "text", text: "Toyota" });
    await run({ kind: "text", text: "Corolla" });
    await run({ kind: "text", text: "2020" });
    await run({ kind: "text", text: "50000" });
    await run({ kind: "text", text: "9000" });
    await run({ kind: "image", mediaId: "media-1" });
    await run({ kind: "text", text: "DONE" });
    await run({ kind: "button", buttonId: "MARKETPLACE_INTAKE_CONFIRM" });

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ step: "COMPLETED", make: "Toyota", model: "Corolla", year: 2020, mileage: 50000, sellingPrice: 9000 });
    expect(flows[0].photoStorageIds).toHaveLength(1);
    expect(flows[0].vehicleEditId).toBeDefined();

    const edits = await t.run((ctx) => ctx.db.query("vehicleEdits").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ type: "CREATE", status: "PENDING" });
    expect(edits[0].payload).toMatchObject({ make: "Toyota", model: "Corolla", year: 2020, mileage: 50000, sellingPrice: 9000, status: "AVAILABLE" });
    expect(edits[0].payload.imageIds).toHaveLength(1);

    // No auto-publish: still no vehicles row until staff approves.
    const vehicles = await t.run((ctx) => ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(vehicles).toHaveLength(0);
  });

  test("cancelling mid-flow marks it CANCELLED and never creates a vehicleEdits request", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedOptedInDealer(t, "962791234567");
    const phone = "962791234567";
    const run = (input: IntakeMessageInput) =>
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, { phone, input });

    await run({ kind: "text", text: "start" });
    await run({ kind: "text", text: "Toyota" });
    await run({ kind: "text", text: "CANCEL" });

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows[0].step).toBe("CANCELLED");

    const edits = await t.run((ctx) => ctx.db.query("vehicleEdits").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(edits).toHaveLength(0);
  });

  test("a message after a completed flow starts a brand new one rather than reusing the finished state", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedOptedInDealer(t, "962791234567");
    const phone = "962791234567";
    const run = (input: IntakeMessageInput) =>
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, { phone, input });

    await run({ kind: "text", text: "start" });
    await run({ kind: "text", text: "CANCEL" });
    await run({ kind: "text", text: "let's try again" });

    const flows = await t.run((ctx) =>
      ctx.db.query("marketplaceWhatsAppFlows").withIndex("by_phone", (q) => q.eq("phone", phone)).collect()
    );
    expect(flows).toHaveLength(2);
    expect(flows[0].step).toBe("CANCELLED");
    expect(flows[1].step).toBe("AWAITING_MAKE");
  });

  test("a rejected photo (bad content type) does not count toward the photo total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        if (url.includes("/messages")) return new Response(JSON.stringify({}), { status: 200 });
        if (url === "https://fake-media-url.example.com/doc.pdf") {
          return new Response(new Blob(["not-an-image"], { type: "application/pdf" }), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          });
        }
        return new Response(JSON.stringify({ url: "https://fake-media-url.example.com/doc.pdf" }), { status: 200 });
      })
    );
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await seedOptedInDealer(t, "962791234567");
    const phone = "962791234567";
    const run = (input: IntakeMessageInput) =>
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, { phone, input });

    await run({ kind: "text", text: "start" });
    await run({ kind: "text", text: "Toyota" });
    await run({ kind: "text", text: "Corolla" });
    await run({ kind: "text", text: "2020" });
    await run({ kind: "text", text: "50000" });
    await run({ kind: "text", text: "9000" });
    await run({ kind: "image", mediaId: "bad-media" });

    const flows = await t.run((ctx) => ctx.db.query("marketplaceWhatsAppFlows").collect());
    expect(flows[0].photoStorageIds).toHaveLength(0);
  });
});

describe("vehicleEdits approval on a WhatsApp-sourced request", () => {
  test("approving the PENDING CREATE request produces a schema-valid vehicles row (color/fuelType/transmission placeholders included)", async () => {
    stubFetchForIntake();
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOptedInDealer(t, "962791234567");
    const phone = "962791234567";
    const run = (input: IntakeMessageInput) =>
      t.action(internal.marketplaceWhatsAppIntake.handleIntakeMessage, { phone, input });

    await run({ kind: "text", text: "start" });
    await run({ kind: "text", text: "Toyota" });
    await run({ kind: "text", text: "Corolla" });
    await run({ kind: "text", text: "2020" });
    await run({ kind: "text", text: "50000" });
    await run({ kind: "text", text: "9000" });
    await run({ kind: "image", mediaId: "media-1" });
    await run({ kind: "text", text: "DONE" });
    await run({ kind: "button", buttonId: "MARKETPLACE_INTAKE_CONFIRM" });

    const edit = (await t.run((ctx) => ctx.db.query("vehicleEdits").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()))[0];

    // convex-test's storage mock doesn't record a Blob's contentType (only
    // size/sha256), so assertVehicleImagesAllowed's real-content-type check
    // would reject any stored test blob here — same gap the rest of this
    // repo's tests dodge by never running that validator against a
    // convex-test-stored file (see vehicles.test.ts's storageId tests, which
    // patch imageIds directly rather than going through a mutation that
    // validates them). Clearing imageIds isolates what this test actually
    // targets: the color/fuelType/transmission/status placeholder defaults.
    await t.run((ctx) => ctx.db.patch(edit._id, { payload: { ...edit.payload, imageIds: [] } }));

    const asOwner = t.withIdentity({ subject: `owner_${orgId}` });
    await asOwner.mutation(api.vehicleEdits.resolve, { orgId, requestId: edit._id, status: "APPROVED" });

    const vehicles = await t.run((ctx) => ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]).toMatchObject({
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      mileage: 50000,
      sellingPrice: 9000,
      color: "Not specified",
      fuelType: "Not specified",
      transmission: "Not specified",
      status: "AVAILABLE",
      addedBy: userId,
    });
  });
});
