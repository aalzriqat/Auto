// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildDraftContext, flattenSocialEvents } from "./draftContext";

const ORG = { dealershipName: "Sunrise Motors", dealershipAddress: "12 Main St", dealershipPhone: "555-0100", currencySymbol: "SAR", currency: "USD" };
const VEHICLE = {
  year: 2022,
  make: "Toyota",
  model: "Camry",
  trim: "SE",
  mileage: 30000,
  color: "White",
  fuelType: "Petrol",
  transmission: "Automatic",
  sellingPrice: 100000,
  status: "AVAILABLE",
};

describe("buildDraftContext field-by-field projection", () => {
  test("copies only the named fields and drops everything else at runtime", () => {
    // Whole documents carry fields the provider must never see. Passing them
    // through a variable keeps TypeScript quiet, so the builder itself has to
    // be the guard.
    const orgDoc = { ...ORG, whatsappApiToken: "SENTINEL_TOKEN", smartReplyCustomTemplatesEn: "SENTINEL_TEMPLATE" };
    const vehicleDoc = {
      ...VEHICLE,
      purchasePrice: 424242,
      landedCostTotal: 535353,
      notes: "SENTINEL_NOTES",
      vin: "SENTINEL_VIN",
      sourcedFromName: "SENTINEL_SUPPLIER",
    };
    const eventDoc = { text: "hello", senderUsername: "SENTINEL_USER", senderInstagramId: "SENTINEL_ID" };
    const context = buildDraftContext({
      org: orgDoc,
      vehicle: vehicleDoc,
      financing: { monthlyAmount: 1677, termMonths: 60, downPaymentPercent: 20 },
      messages: flattenSocialEvents([eventDoc]),
    });
    const serialized = JSON.stringify(context);
    for (const forbidden of ["SENTINEL", "424242", "535353"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(context.org).sort()).toEqual(["address", "currency", "name", "phone"]);
    expect(context.vehicle).toEqual({
      year: 2022,
      make: "Toyota",
      model: "Camry",
      trim: "SE",
      mileage: 30000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      status: "AVAILABLE",
      listedPrice: 100000,
    });
  });

  test("currency prefers the symbol and falls back to the code", () => {
    expect(buildDraftContext({ org: ORG, vehicle: null, financing: null, messages: [] }).org.currency).toBe("SAR");
    expect(
      buildDraftContext({ org: { currencySymbol: "", currency: "USD" }, vehicle: null, financing: null, messages: [] }).org.currency,
    ).toBe("USD");
  });

  test("the listed price and the financing estimate exist only for an AVAILABLE vehicle", () => {
    const sold = buildDraftContext({
      org: ORG,
      vehicle: { ...VEHICLE, status: "SOLD" },
      financing: { monthlyAmount: 1677, termMonths: 60, downPaymentPercent: 20 },
      messages: [],
    });
    expect(sold.vehicle?.listedPrice).toBeUndefined();
    expect(sold.financing).toBeNull();
    expect(sold.vehicle?.status).toBe("SOLD");
  });
});

describe("conversation projection", () => {
  test("flattens events into customer and dealership messages, oldest first", () => {
    expect(
      flattenSocialEvents([
        { text: "Is it available?", autoReplyText: "Yes it is", manualReplyText: "Come by today" },
        { text: "Thanks" },
      ]),
    ).toEqual([
      { direction: "customer", text: "Is it available?" },
      { direction: "dealership", text: "Yes it is" },
      { direction: "dealership", text: "Come by today" },
      { direction: "customer", text: "Thanks" },
    ]);
  });

  test("keeps the newest 12 messages, cuts each to 1,500 characters and drops empty ones", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      direction: "customer" as const,
      text: i === 14 ? "x".repeat(2000) : `m${i}`,
    }));
    messages.splice(3, 0, { direction: "customer", text: "   " });
    const context = buildDraftContext({ org: ORG, vehicle: null, financing: null, messages });
    expect(context.conversation).toHaveLength(12);
    expect(context.conversation[0]?.text).toBe("m3");
    expect(context.conversation[11]?.text).toBe("x".repeat(1500));
  });

  test("cuts by code point, never inside a surrogate pair", () => {
    const text = "😀".repeat(1600);
    const context = buildDraftContext({
      org: ORG,
      vehicle: null,
      financing: null,
      messages: [{ direction: "customer", text }],
    });
    expect(context.conversation[0]?.text).toBe("😀".repeat(1500));
  });
});
