import { describe, expect, test } from "vitest";
import { extractClientCalls } from "./clientPaths.mjs";
import { compareContracts, SEVERITY } from "./compare.mjs";

type Validator = {
  type: string;
  tableName?: string;
  value?: Record<string, { fieldType: Validator; optional: boolean }>;
};

type ExtractedCall = ReturnType<typeof extractClientCalls>["calls"][number];

const stringValidator: Validator = { type: "string" };
const idValidator = (tableName: string): Validator => ({ type: "id", tableName });
const objectValidator = (fields: Record<string, Validator>): Validator => ({
  type: "object",
  value: Object.fromEntries(
    Object.entries(fields).map(([name, fieldType]) => [name, { fieldType, optional: false }]),
  ),
});

const functionSpec = (definitions: Record<string, Validator>) => ({
  functions: Object.entries(definitions).map(([identifier, args]) => ({
    identifier: identifier.replace(":", ".js:"),
    args,
  })),
});

const callFor = (calls: ExtractedCall[], identifier: string) => {
  const call = calls.find((candidate) => candidate.identifier === identifier);
  expect(call, `missing extracted call ${identifier}`).toBeDefined();
  return call as ExtractedCall;
};

const reachabilityFixture =
  "scripts/contractSkew/__fixtures__/transmissionReachabilityCases.tsx";
let cachedReachabilityCalls: ExtractedCall[] | null = null;
const reachabilityCalls = () => {
  cachedReachabilityCalls ??= extractClientCalls(
    [reachabilityFixture],
    "scripts/contractSkew/tsconfig.json",
  ).calls;
  return cachedReachabilityCalls;
};

const exactLiveSpec = functionSpec({
  "websites:preview": objectValidator({ orgId: idValidator("organizations") }),
  "marketplaceRequests:getStatusForBuyer": objectValidator({
    requestId: idValidator("marketplaceRequests"),
    buyerPhone: stringValidator,
  }),
  "marketplaceTradeIns:getStatusForBuyer": objectValidator({
    tradeInRequestId: idValidator("marketplaceTradeInRequests"),
    buyerPhone: stringValidator,
  }),
  "marketplaceTradeIns:acceptOffer": objectValidator({
    tradeInRequestId: idValidator("marketplaceTradeInRequests"),
    buyerPhone: stringValidator,
  }),
  "marketplaceTradeIns:declineOffer": objectValidator({
    tradeInRequestId: idValidator("marketplaceTradeInRequests"),
    buyerPhone: stringValidator,
  }),
  "guarantors:listByCustomer": objectValidator({
    orgId: idValidator("organizations"),
    customerId: idValidator("customers"),
  }),
  "deposits:listByVehicle": objectValidator({
    orgId: idValidator("organizations"),
    vehicleId: idValidator("vehicles"),
  }),
  "vehicles:getLandedCosts": objectValidator({
    orgId: idValidator("organizations"),
    vehicleId: idValidator("vehicles"),
  }),
  "vehicles:getPricingHistory": objectValidator({
    orgId: idValidator("organizations"),
    vehicleId: idValidator("vehicles"),
  }),
  "vehicles:getReservationHistory": objectValidator({
    orgId: idValidator("organizations"),
    vehicleId: idValidator("vehicles"),
  }),
  "finance:listValuations": objectValidator({
    orgId: idValidator("organizations"),
    vehicleId: idValidator("vehicles"),
  }),
});

describe("transmission reachability through the real TypeChecker and comparator", () => {
  test("SCRUM-178: the exact 11 live false-BREAKING shapes exclude non-running alternatives", () => {
    const webFiles = [
      "app/dealer-site/[[...slug]]/page.tsx",
      "app/marketplace/status/[id]/page.tsx",
      "app/marketplace/tradein/[id]/page.tsx",
    ];
    const mobileFiles = [
      "apps/mobile/src/features/workspace/CustomerDetailScreen.tsx",
      "apps/mobile/src/features/workspace/VehicleDetailScreen.tsx",
    ];
    const targetIdentifiers = new Set(
      exactLiveSpec.functions.map((entry) => entry.identifier.replace(".js:", ":")),
    );
    const calls = [
      ...extractClientCalls(webFiles, "tsconfig.json").calls,
      ...extractClientCalls(mobileFiles, "apps/mobile/tsconfig.json").calls,
    ].filter((call) => targetIdentifiers.has(call.identifier));

    expect(calls).toHaveLength(11);
    const result = compareContracts(calls, exactLiveSpec);
    expect(result.breaking).toEqual([]);
    for (const identifier of targetIdentifiers) {
      expect(
        result.needsEvidence.some((finding) => finding.identifier === identifier),
        `${identifier} should retain honest ID uncertainty`,
      ).toBe(true);
    }
  }, 60_000);

  test("a singular [id] route is string-only evidence, while catch-all routes remain arrays", () => {
    const routeFiles = [
      "scripts/contractSkew/__fixtures__/routes/singular/[id]/page.tsx",
      "scripts/contractSkew/__fixtures__/routes/catch-all/[...id]/page.tsx",
      "scripts/contractSkew/__fixtures__/routes/optional-catch-all/[[...id]]/page.tsx",
    ];
    const calls = extractClientCalls(routeFiles, "scripts/contractSkew/tsconfig.json").calls;
    const spec = functionSpec({
      "routes:singular": objectValidator({ requestId: idValidator("requests") }),
      "routes:shadowed": objectValidator({ requestId: idValidator("requests") }),
      "routes:catchAll": objectValidator({ requestId: idValidator("requests") }),
      "routes:optionalCatchAll": objectValidator({ requestId: idValidator("requests") }),
    });

    const singular = compareContracts([callFor(calls, "routes:singular")], spec);
    expect(singular.breaking).toEqual([]);
    expect(singular.needsEvidence).toContainEqual(
      expect.objectContaining({
        identifier: "routes:singular",
        path: "requestId",
        severity: SEVERITY.TYPE_UNKNOWN,
      }),
    );

    for (const identifier of [
      "routes:shadowed",
      "routes:catchAll",
      "routes:optionalCatchAll",
    ]) {
      const result = compareContracts([callFor(calls, identifier)], spec);
      expect(result.breaking).toContainEqual(
        expect.objectContaining({ identifier, path: "requestId" }),
      );
    }
  });

  test("nullable scoped args are narrowed at the running use site", () => {
    const calls = reachabilityCalls();
    const result = compareContracts(
      [callFor(calls, "reachability:scopedArgs")],
      functionSpec({
        "reachability:scopedArgs": objectValidator({
          orgId: stringValidator,
          customerId: stringValidator,
        }),
      }),
    );
    expect(result.findings).toEqual([]);
  });

  test("metamorphic: changing only a non-running falsy alternative cannot change transmitted evidence", () => {
    const calls = reachabilityCalls();
    const baseline = callFor(calls, "reachability:nonRunningBaseline");
    for (const identifier of [
      "reachability:nonRunningNull",
      "reachability:nonRunningFalse",
      "reachability:nonRunningZero",
      "reachability:nonRunningEmptyString",
    ]) {
      expect(callFor(calls, identifier).payload).toEqual(baseline.payload);
    }
  });

  test("a truly transmitted incompatible conditional branch still BREAKS", () => {
    const calls = reachabilityCalls();
    const result = compareContracts(
      [callFor(calls, "reachability:transmittedConditional")],
      functionSpec({
        "reachability:transmittedConditional": objectValidator({ value: stringValidator }),
      }),
    );
    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        identifier: "reachability:transmittedConditional",
        path: "value",
      }),
    );
  });

  test("a mutable assertion-bearing alias remains UNKNOWN rather than gaining flow trust", () => {
    const calls = reachabilityCalls();
    const result = compareContracts(
      [callFor(calls, "reachability:mutableAlias")],
      functionSpec({
        "reachability:mutableAlias": objectValidator({ value: stringValidator }),
      }),
    );
    expect(result.breaking).toEqual([]);
    expect(
      result.needsEvidence.some(
        (finding) =>
          finding.identifier === "reachability:mutableAlias" &&
          finding.severity.endsWith("_UNKNOWN"),
      ),
    ).toBe(true);
  });
});
