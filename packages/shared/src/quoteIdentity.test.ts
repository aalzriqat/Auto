import { describe, expect, test } from "vitest";
import { canonicalRequestFingerprint, newQuoteOperationKey } from "./quoteIdentity";

/**
 * The properties this key has to have, stated as tests rather than as comments,
 * because every one of them fails silently if it stops holding: a wrong key
 * does not throw, it just quietly returns somebody else's quote or mints a
 * duplicate root.
 */
describe("canonicalRequestFingerprint", () => {
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
    expect(canonicalRequestFingerprint(payload)).toBe(canonicalRequestFingerprint({ ...payload }));
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
    expect(canonicalRequestFingerprint(reordered)).toBe(canonicalRequestFingerprint(payload));
  });

  test("an omitted field and an explicitly undefined one are the same intention", () => {
    expect(canonicalRequestFingerprint({ ...payload, leadId: undefined })).toBe(
      canonicalRequestFingerprint(payload)
    );
  });

  test("a CHANGED PRICE is a different request", () => {
    // What this buys: a reused operation key carrying a changed price is a
    // CONFLICT rather than a silent old answer.
    //
    // ⚠️ Not "a new revision" — an earlier version of this comment said that
    // and it was wrong. The server only links a revision when
    // `supersedesQuoteId` is supplied; an edited NEW submission is an
    // independent lineage.
    expect(canonicalRequestFingerprint({ ...payload, vehiclePrice: 27_000 })).not.toBe(
      canonicalRequestFingerprint(payload)
    );
  });

  test("a different CUSTOMER or VEHICLE is a different intention", () => {
    expect(canonicalRequestFingerprint({ ...payload, customerId: "cust2" })).not.toBe(
      canonicalRequestFingerprint(payload)
    );
    expect(canonicalRequestFingerprint({ ...payload, vehicleId: "veh2" })).not.toBe(
      canonicalRequestFingerprint(payload)
    );
  });

  test("ARRAY ORDER is meaningful — two cars swapped is a different quote", () => {
    const a = { ...payload, vehicleItems: [{ vehicleId: "v1" }, { vehicleId: "v2" }] };
    const b = { ...payload, vehicleItems: [{ vehicleId: "v2" }, { vehicleId: "v1" }] };
    expect(canonicalRequestFingerprint(a)).not.toBe(canonicalRequestFingerprint(b));
  });

  test("values that stringify alike stay distinct", () => {
    // "1" and 1 both serialise to something containing 1; conflating them would
    // let a string id collide with a number field.
    expect(canonicalRequestFingerprint({ v: "1" })).not.toBe(canonicalRequestFingerprint({ v: 1 }));
    expect(canonicalRequestFingerprint({ v: null })).not.toBe(
      canonicalRequestFingerprint({ v: "null" })
    );
  });

  test("nested differences are not lost", () => {
    const a = { ...payload, vehicleItems: [{ vehicleId: "v1", unitPrice: 10 }] };
    const b = { ...payload, vehicleItems: [{ vehicleId: "v1", unitPrice: 11 }] };
    expect(canonicalRequestFingerprint(a)).not.toBe(canonicalRequestFingerprint(b));
  });

  test("the fingerprint is short, printable and distinguishable from an operation key", () => {
    const key = canonicalRequestFingerprint(payload);
    // `f_` for fingerprint, `op_` for operation. The two are different kinds of
    // thing and the prefixes make a mix-up visible in a log line.
    expect(key.startsWith("f_")).toBe(true);
    expect(key).toMatch(/^f_[0-9a-z]+_[0-9a-z]+$/);
    expect(key.length).toBeLessThan(40);
  });

  test("near-identical payloads do not collide across a realistic spread", () => {
    // One hash over short, highly similar strings collides more often than is
    // comfortable, and a collision here returns another customer's quote id.
    const keys = new Set<string>();
    for (let price = 1_000; price < 6_000; price++) {
      keys.add(canonicalRequestFingerprint({ ...payload, vehiclePrice: price }));
    }
    expect(keys.size).toBe(5_000);
  });
});

describe("newQuoteOperationKey", () => {
  test("every call is a NEW submission identity", () => {
    // The property the payload-hash design got wrong: two identical intentions
    // must be able to be two submissions.
    const keys = new Set(Array.from({ length: 1_000 }, () => newQuoteOperationKey()));
    expect(keys.size).toBe(1_000);
  });

  test("the key does NOT depend on any payload", () => {
    expect(newQuoteOperationKey()).not.toBe(newQuoteOperationKey());
  });

  test("the key is printable and prefixed", () => {
    expect(newQuoteOperationKey()).toMatch(/^op_[0-9a-z]+_[0-9a-z]+$/);
  });
});
