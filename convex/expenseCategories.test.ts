import { expect, test } from "vitest";
import { create, update } from "./expenses";
import schema from "./schema";
import native from "./__fixtures__/expense-category-native.json";

test.each([["create", create, false], ["update", update, true]] as const)(
  "registered expense %s retains the independently captured native category contract", (_name, registration, optional) => {
    const exportArgs: unknown = Reflect.get(registration, "exportArgs");
    if (typeof exportArgs !== "function") throw new Error("Native registered args unavailable");
    const rendered: unknown = exportArgs();
    if (typeof rendered !== "string") throw new Error("Native registered args JSON unavailable");
    expect(JSON.parse(rendered)).toMatchObject({ type: "object", value: { category: { fieldType: native.category, optional } } });
  },
);

test("stored expense categories retain every native value including prepaid in its original order", () => {
  const validator = schema.tables.expenses.validator;
  if (!("json" in validator)) throw new Error("Native stored-schema metadata unavailable");
  expect(validator.json).toMatchObject({ type: "object", value: { category: { fieldType: native.category, optional: false } } });
});
