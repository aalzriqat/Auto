// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("SCRUM-881: Expo Router parses encoded query values with the patched decoder", () => {
  const mobileRequire = createRequire(
    new URL("../apps/mobile/package.json", import.meta.url),
  );
  const routerRequire = createRequire(mobileRequire.resolve("expo-router"));
  const queryString: { parse(query: string): Record<string, unknown> } =
    routerRequire("query-string");

  expect(
    queryString.parse("name=hello%20world&city=%D8%B9%D9%85%D8%A7%D9%86&bad=%ZZ"),
  ).toEqual({ name: "hello world", city: "عمان", bad: "%ZZ" });
});
