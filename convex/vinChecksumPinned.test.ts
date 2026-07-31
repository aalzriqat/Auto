import { expect, test } from "vitest";
import { validateVinChecksum } from "../lib/vinHelpers";
import { hasVinWarning } from "./aggregates";

/**
 * `vehicleQualityByOrg` stores each vehicle's VIN-validity as part of its sort
 * key, which makes `validateVinChecksum` the one function in this repo whose
 * *output is persisted inside a B-tree*.
 *
 * That is a different contract from an ordinary pure function. Change what it
 * returns for any VIN already in a deployment and nothing fails: the writes
 * keep succeeding, no exception is raised, and the tree simply keeps counting
 * that vehicle under the answer it gave at insert time. The dashboard's
 * data-quality card then reports a number that is wrong and cannot correct
 * itself, because no row will be rewritten just because an algorithm moved.
 *
 * So this file exists to make that change loud instead of silent. If it starts
 * failing, the code is not necessarily wrong — but the deployment now needs a
 * rebuild of `vehicleQualityByOrg` (see `migrations.rebuildVehicleAggregates`)
 * as part of the same release, and this test's expectations updated to match.
 */

/** VINs whose classification is now load-bearing for stored aggregate keys. */
const PINNED: Array<{ vin: string; valid: boolean; why: string }> = [
  { vin: "1HGCM82633A004352", valid: true, why: "real Honda Accord VIN, check digit 3" },
  { vin: "JH4TB2H26CC000000", valid: true, why: "check digit 6, transliterated letters" },
  { vin: "1M8GDM9AXKP042788", valid: true, why: "check digit X, the one non-numeric case" },
  { vin: "NONNAVINNOCHECKSUM", valid: false, why: "18 chars — wrong length" },
  {
    vin: "1HGCM82633A004353",
    valid: false,
    // Position 9 (the check digit) is still 3 and matches nothing now: the
    // altered character is the last one, so the *body* changed out from under
    // a check digit that stayed put. That is the realistic corruption — a
    // mistyped serial — rather than someone editing the check digit itself.
    why: "valid VIN with its final VIS character altered, check digit left at 3",
  },
  { vin: "1HGCM82633A00435I", valid: false, why: "contains I, disallowed in a VIN" },
  { vin: "1HGCM82633A00435O", valid: false, why: "contains O, disallowed in a VIN" },
  { vin: "1HGCM82633A00435Q", valid: false, why: "contains Q, disallowed in a VIN" },
  { vin: "", valid: false, why: "empty" },
  { vin: "1HGCM82633A00435", valid: false, why: "16 chars — one short" },
];

test.each(PINNED)(
  "validateVinChecksum($vin) stays $valid — $why",
  ({ vin, valid }) => {
    expect(validateVinChecksum(vin)).toBe(valid);
  },
);

test("hasVinWarning treats a missing VIN as fine, not as a warning", () => {
  // The card nudges about VINs that look wrong, not about VINs not yet entered
  // — and this is the predicate the aggregate key is built from, so it is
  // pinned alongside the checksum itself.
  expect(hasVinWarning({})).toBe(false);
  expect(hasVinWarning({ vin: undefined })).toBe(false);
  expect(hasVinWarning({ vin: "" })).toBe(false);
  expect(hasVinWarning({ vin: "1HGCM82633A004352" })).toBe(false);
  expect(hasVinWarning({ vin: "NONNAVINNOCHECKSUM" })).toBe(true);
});
