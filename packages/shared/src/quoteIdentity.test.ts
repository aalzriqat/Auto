import { describe, expect, test } from "vitest";
import { stableQuoteIdempotencyKey } from "./quoteIdentity";

/**
 * The properties this key has to have, stated as tests rather than as comments,
 * because every one of them fails silently if it stops holding: a wrong key
 * does not throw, it just quietly returns somebody else's quote or mints a
 * duplicate root.
 */
describe("stableQuoteIdempotencyKey", () => {
  const payload = {
    orgId: "org1",
    customerId: "cust1",
    vehicleId: "veh1",
    mode: "CASH",
    vehiclePrice: 28_000,
    downPayment: 0,
    termMonths: 0,
  };

  test("the same intention produces the same key", () => {
    expect(stableQuoteIdempotencyKey(payload)).toBe(stableQuoteIdempotencyKey({ ...payload }));
  });

  test("PROPERTY ORDER does not change the key", () => {
    // The reason this matters: the wizard and the quick-quote dialog build the
    // same quote through different code paths, so insertion order differs. A
    // key that moved with it would make a retry look like a new deal.
    const reordered = {
      termMonths: 0,
      vehiclePrice: 28_000,
      customerId: "cust1",
      downPayment: 0,
      orgId: "org1",
      mode: "CASH",
      vehicleId: "veh1",
    };
    expect(stableQuoteIdempotencyKey(reordered)).toBe(stableQuoteIdempotencyKey(payload));
  });

  test("an omitted field and an explicitly undefined one are the same intention", () => {
    expect(stableQuoteIdempotencyKey({ ...payload, leadId: undefined })).toBe(
      stableQuoteIdempotencyKey(payload)
    );
  });

  test("a CHANGED PRICE is a different intention", () => {
    // The property that keeps the server's conflict branch unreachable from
    // these clients: edit and resubmit is a new revision, not a refusal.
    expect(stableQuoteIdempotencyKey({ ...payload, vehiclePrice: 27_000 })).not.toBe(
      stableQuoteIdempotencyKey(payload)
    );
  });

  test("a different CUSTOMER or VEHICLE is a different intention", () => {
    expect(stableQuoteIdempotencyKey({ ...payload, customerId: "cust2" })).not.toBe(
      stableQuoteIdempotencyKey(payload)
    );
    expect(stableQuoteIdempotencyKey({ ...payload, vehicleId: "veh2" })).not.toBe(
      stableQuoteIdempotencyKey(payload)
    );
  });

  test("ARRAY ORDER is meaningful — two cars swapped is a different quote", () => {
    const a = { ...payload, vehicleItems: [{ vehicleId: "v1" }, { vehicleId: "v2" }] };
    const b = { ...payload, vehicleItems: [{ vehicleId: "v2" }, { vehicleId: "v1" }] };
    expect(stableQuoteIdempotencyKey(a)).not.toBe(stableQuoteIdempotencyKey(b));
  });

  test("values that stringify alike stay distinct", () => {
    // "1" and 1 both serialise to something containing 1; conflating them would
    // let a string id collide with a number field.
    expect(stableQuoteIdempotencyKey({ v: "1" })).not.toBe(stableQuoteIdempotencyKey({ v: 1 }));
    expect(stableQuoteIdempotencyKey({ v: null })).not.toBe(
      stableQuoteIdempotencyKey({ v: "null" })
    );
  });

  test("nested differences are not lost", () => {
    const a = { ...payload, vehicleItems: [{ vehicleId: "v1", unitPrice: 10 }] };
    const b = { ...payload, vehicleItems: [{ vehicleId: "v1", unitPrice: 11 }] };
    expect(stableQuoteIdempotencyKey(a)).not.toBe(stableQuoteIdempotencyKey(b));
  });

  test("the key is short, printable and prefixed", () => {
    const key = stableQuoteIdempotencyKey(payload);
    expect(key.startsWith("q_")).toBe(true);
    expect(key).toMatch(/^q_[0-9a-z]+_[0-9a-z]+$/);
    expect(key.length).toBeLessThan(40);
  });

  test("near-identical payloads do not collide across a realistic spread", () => {
    // One hash over short, highly similar strings collides more often than is
    // comfortable, and a collision here returns another customer's quote id.
    const keys = new Set<string>();
    for (let price = 1_000; price < 6_000; price++) {
      keys.add(stableQuoteIdempotencyKey({ ...payload, vehiclePrice: price }));
    }
    expect(keys.size).toBe(5_000);
  });
});
