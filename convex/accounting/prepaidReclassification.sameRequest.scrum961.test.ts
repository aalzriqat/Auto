// @vitest-environment node
import { expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { sameReclassRequest } from "./prepaidReclassification";

/** Idempotent replay decides on this: the same person and amount lines in any order are the same request. */
const id = (value: string) => value as Id<"users">;
const [anna, bob] = [id("user_b"), id("user_a")];
const requester = id("requester");
const row = (lines: { userId: Id<"users">; amountMinor: number }[], reason = "move") =>
  ({ requestedBy: requester, reason, lines }) as unknown as Doc<"openingPrepaidReclassifications">;

test("the same lines in a different order are the same request", () => {
  const stored = row([{ userId: anna, amountMinor: 100 }, { userId: bob, amountMinor: 250 }]);
  expect(sameReclassRequest(stored, requester, [{ userId: bob, amountMinor: 250 }, { userId: anna, amountMinor: 100 }], "move")).toBe(true);
});
test("a different amount, person, reason or requester is a different request", () => {
  const stored = row([{ userId: anna, amountMinor: 100 }, { userId: bob, amountMinor: 250 }]);
  const lines = (a: number, who = bob) => [{ userId: anna, amountMinor: 100 }, { userId: who, amountMinor: a }];
  expect(sameReclassRequest(stored, requester, lines(251), "move")).toBe(false);
  expect(sameReclassRequest(stored, requester, lines(250, id("user_c")), "move")).toBe(false);
  expect(sameReclassRequest(stored, requester, lines(250), "other")).toBe(false);
  expect(sameReclassRequest(stored, id("someone_else"), lines(250), "move")).toBe(false);
  expect(sameReclassRequest(stored, requester, [{ userId: anna, amountMinor: 100 }], "move")).toBe(false);
});
