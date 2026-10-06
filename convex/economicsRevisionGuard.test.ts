/**
 * Contract test for the economics revision counter.
 *
 * `registerVehicleHandover` refuses a confirmation whose `economicsStamp` no
 * longer matches the deal, and that stamp is `economicsRevision` and nothing
 * else. So the guarantee holds only while every write that moves the deal's
 * economics also ADVANCES the counter. A forgotten bump fails OPEN: a
 * confirmation taken against figures that have since changed seals anyway.
 *
 * The analyser and its self-tests live in `scripts/economicsRevisionAnalyzer*`
 * (SCRUM-703): they need Node file-system access, which the convex-lint hook
 * rejects under `convex/`. This file is the repo scan, and is a ratchet rather
 * than a proof — the behavioural stale-stamp tests are the real guarantee.
 */
import { describe, expect, test } from "vitest";
import {
  scanBackendForUnbumpedEconomicsWrites,
  staleExceptions,
} from "../scripts/economicsRevisionAnalyzer";

describe("every economics writer in convex/ bumps the revision", () => {
  test("no unreviewed write moves the deal's economics without advancing the revision", () => {
    const offences = scanBackendForUnbumpedEconomicsWrites();

    expect(
      offences,
      `These patches move the deal's economics without ADVANCING economicsRevision, so a
handover confirmation taken before them would still compare equal and seal:

${offences.map((o) => `  ${o.file}: ${o.snippet.replace(/\s+/g, " ")}`).join("\n")}
`
    ).toEqual([]);
  });

  test("every reviewed exception still excuses a real write", () => {
    expect(staleExceptions(), "Delete these from REVIEWED_EXCEPTIONS: the code they excused is gone or fixed.").toEqual([]);
  });
});
