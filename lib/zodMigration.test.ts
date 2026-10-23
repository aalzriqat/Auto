import { afterEach, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateCustomerSchema } from "@/convex/validations/customers";
import { validateInput } from "@/convex/utils/validation";
import { getAuthConfigEnv, getValidatedEnv } from "@/convex/utils/env";
import { taskSchema } from "@/components/tasks/task.schema";
import { step1Schema } from "@/components/sales/wizard/schemas";
import { prepaidCorrectionSchema } from "@/components/accounting/prepaidCorrection.schema";

afterEach(() => vi.unstubAllEnvs());

test("invalid customer input remains a controlled validation error after the Zod upgrade", () => {
  const customer = { orgId: "synthetic-org", firstName: "Synthetic", lastName: "Customer" };
  expect(validateInput(CreateCustomerSchema, customer)).toEqual(customer);
  expect(() => validateInput(CreateCustomerSchema, { ...customer, firstName: "" }))
    .toThrow(new ConvexError("Validation failed: firstName: First name is required"));
});

test.each([
  ["auth", getAuthConfigEnv, "Auth Environment Variable Missing/Invalid: CLERK_JWT_ISSUER_DOMAIN"],
  ["backend", getValidatedEnv, "Backend Environment Variables Missing/Invalid: CLERK_JWT_ISSUER_DOMAIN"],
])("invalid %s configuration reports the field without leaking its value", (_name, readEnv, message) => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "invalid-synthetic-issuer");
  vi.stubEnv("CLERK_DEV_JWT_ISSUER_DOMAIN", "https://synthetic.accounts.dev");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://synthetic.example");
  expect(readEnv).toThrow(new ConvexError(message));
});

test("a cleared task date retains its required message", () => {
  const parsed = taskSchema.safeParse({ title: "Synthetic task", assignedTo: "synthetic-user", status: "PENDING" });
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["dueDate"], message: "Due date is required" }),
    ]));
  }
});

test("task resolver returns field errors instead of rejecting an invalid submission", async () => {
  const resolve = zodResolver(taskSchema);
  const result = await resolve({ title: "", dueDate: new Date("2026-10-01T00:00:00Z"),
    assignedTo: "synthetic-user", status: "PENDING" }, undefined, { fields: {}, shouldUseNativeValidation: false });
  expect(result.errors.title?.message).toBe("Title is required");
  expect(result.values).toEqual({});
});

test.each([
  { vehiclePrice: 5000, desiredProfit: 300, downPayment: 100, termMonths: 12 },
  { vehiclePrice: "5000", desiredProfit: "300", downPayment: "100", termMonths: "12" },
])("quote setup resolver keeps parsed numeric values and the vehicle requirement: %j", async (amounts) => {
  const resolve = zodResolver(step1Schema);
  const input = { vehicleId: "synthetic-vehicle", ...amounts };
  const result = await resolve(input, undefined, { fields: {}, shouldUseNativeValidation: false });
  expect(result.errors).toEqual({});
  expect(result.values).toEqual({ vehicleId: "synthetic-vehicle", vehiclePrice: 5000, desiredProfit: 300, downPayment: 100, termMonths: 12 });
  const invalid = await resolve({ ...input, vehicleId: "" }, undefined, { fields: {}, shouldUseNativeValidation: false });
  expect(invalid.errors.vehicleId).toBeDefined();
  expect(invalid.values).toEqual({});
});

test("a prepaid write-off keeps omitted refund defaults and the refund-method requirement", () => {
  expect(prepaidCorrectionSchema.parse({ reason: "Synthetic correction", writeOffAmount: "5" })).toEqual({
    reason: "Synthetic correction", writeOffAmount: 5, refundAmount: 0, refundTaxAmount: 0, changeTerm: false,
  });
  const invalid = prepaidCorrectionSchema.safeParse({ reason: "Synthetic correction", refundAmount: "5" });
  expect(invalid.success).toBe(false);
  if (!invalid.success) {
    expect(invalid.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["refundPaymentMethod"], message: "Select how the refund was received" }),
    ]));
  }
});
