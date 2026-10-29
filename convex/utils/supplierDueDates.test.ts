import { describe, expect, test } from "vitest";
import {
  AMMAN_TIME_ZONE,
  DUE_TRIGGERS,
  agingFor,
  ammanDateString,
  bucketFor,
  deriveDueDate,
  daysOverdue,
} from "./supplierDueDates";

/**
 * SCRUM-869 S3a, owner ruling SCRUM-869#c23883 (OQ-1): a supplier obligation's due date is derived
 * server-side and explained: the agreed date, else the ownership-model trigger read from recorded
 * facts only, else "No due date" (never invented, never overdue). Aging buckets are Current, 1-30,
 * 31-60, 61-90, 90+ days overdue, counted in Asia/Amman calendar days.
 *
 * c23883 is the coordinator's Jira record of a chat ruling, not the owner's own text.
 *
 * Time zone evidence: these tests run against the real ICU data of the Node runtime. Jordan moved to
 * permanent UTC+3 in October 2022 (https://www.iana.org/time-zones, tzdata "asia" file, Asia/Amman);
 * before that it observed UTC+2 in winter and UTC+3 in summer. A fixed +03:00 offset would pass the
 * 2026 cases and fail the 2021 winter case, so the 2021 case proves the zone is looked up, not assumed.
 */

const utc = (iso: string): number => Date.parse(iso);

describe("Asia/Amman calendar days", () => {
  test("the zone is the IANA identifier the owner named", () => {
    expect(AMMAN_TIME_ZONE).toBe("Asia/Amman");
  });

  test("winter 2026 (UTC+3): 20:59:59.999Z is still the same Amman day, 21:00Z is the next", () => {
    expect(ammanDateString(utc("2026-01-10T20:59:59.999Z"))).toBe("2026-01-10");
    expect(ammanDateString(utc("2026-01-10T21:00:00.000Z"))).toBe("2026-01-11");
  });

  test("summer 2026 (UTC+3 all year since 2022): the same boundary, 21:00Z", () => {
    expect(ammanDateString(utc("2026-07-10T20:59:59.999Z"))).toBe("2026-07-10");
    expect(ammanDateString(utc("2026-07-10T21:00:00.000Z"))).toBe("2026-07-11");
  });

  test("winter 2021 (UTC+2 under the old rules): the boundary is 22:00Z, so the zone is looked up", () => {
    expect(ammanDateString(utc("2021-01-10T21:30:00.000Z"))).toBe("2021-01-10");
    expect(ammanDateString(utc("2021-01-10T22:00:00.000Z"))).toBe("2021-01-11");
  });

  test("summer 2021 (UTC+3 daylight time): the boundary is 21:00Z", () => {
    expect(ammanDateString(utc("2021-07-10T20:59:59.999Z"))).toBe("2021-07-10");
    expect(ammanDateString(utc("2021-07-10T21:00:00.000Z"))).toBe("2021-07-11");
  });

  test("days overdue counts Amman calendar days, not 24-hour spans", () => {
    const due = utc("2026-01-10T01:00:00.000Z"); // 04:00 Amman, 10 January
    expect(daysOverdue(due, utc("2026-01-10T20:59:59.999Z"))).toBe(0); // 23:59 Amman, same day
    expect(daysOverdue(due, utc("2026-01-10T21:00:00.000Z"))).toBe(1); // 00:00 Amman, 11 January
    // Less than 24 hours after the due instant, but already the next calendar day in Amman.
    expect(daysOverdue(due, utc("2026-01-10T21:00:00.000Z")) * 24 * 3600 * 1000).toBeGreaterThan(
      utc("2026-01-10T21:00:00.000Z") - due
    );
    expect(daysOverdue(due, utc("2026-01-09T21:00:00.000Z"))).toBe(-1); // due tomorrow
  });
});

describe("aging buckets (c23883: Current, 1-30, 31-60, 61-90, 90+)", () => {
  const cases: [number, ReturnType<typeof bucketFor>][] = [
    [-5, "CURRENT"],
    [0, "CURRENT"],
    [1, "DAYS_1_30"],
    [30, "DAYS_1_30"],
    [31, "DAYS_31_60"],
    [60, "DAYS_31_60"],
    [61, "DAYS_61_90"],
    [90, "DAYS_61_90"],
    [91, "DAYS_90_PLUS"],
    [400, "DAYS_90_PLUS"],
  ];
  test.each(cases)("%i days overdue is %s", (days, bucket) => {
    expect(bucketFor(days)).toBe(bucket);
  });

  test("no due date is its own bucket, with no day count, and is never overdue", () => {
    expect(agingFor(null, utc("2030-01-01T00:00:00Z"))).toEqual({
      daysOverdue: null,
      bucket: "NO_DUE_DATE",
    });
  });

  test("a due date resolves to its bucket at the Amman midnight edge", () => {
    const due = utc("2026-01-01T09:00:00Z");
    expect(agingFor(due, utc("2026-01-31T20:59:59.999Z"))).toEqual({ daysOverdue: 30, bucket: "DAYS_1_30" });
    expect(agingFor(due, utc("2026-01-31T21:00:00.000Z"))).toEqual({ daysOverdue: 31, bucket: "DAYS_31_60" });
  });
});

describe("due-date derivation (c23883 OQ-1)", () => {
  const AGREED = utc("2026-03-15T09:00:00Z");
  const DELIVERED = utc("2026-02-01T09:00:00Z");

  test("an agreed date always wins, for every ownership model", () => {
    for (const model of Object.keys(DUE_TRIGGERS) as (keyof typeof DUE_TRIGGERS)[]) {
      const derived = deriveDueDate(model, { agreedDueAt: AGREED, deliveredAt: DELIVERED });
      expect(derived).toMatchObject({ dueAt: AGREED, rule: "AGREED_DATE" });
      expect(derived.explanation.length).toBeGreaterThan(0);
    }
  });

  test("SOURCED DIRECT_TO_SUPPLIER commission receivable: due on the recorded delivery", () => {
    expect(deriveDueDate("SOURCED_DIRECT_RECEIVABLE", { deliveredAt: DELIVERED })).toMatchObject({
      dueAt: DELIVERED,
      rule: "DELIVERY_RECORDED",
    });
  });

  test("SOURCED DIRECT_TO_SUPPLIER receivable with no recorded delivery has no due date", () => {
    expect(deriveDueDate("SOURCED_DIRECT_RECEIVABLE", {})).toMatchObject({
      dueAt: null,
      rule: "DELIVERY_NOT_RECORDED",
    });
  });

  test("SOURCED THROUGH_DEALERSHIP payable: cleared proceeds are not recorded anywhere, so no due date", () => {
    // Coordinator ruling 2026-10-29: no trigger until the owner names the record. A delivery date
    // must not stand in for cleared proceeds.
    expect(deriveDueDate("SOURCED_THROUGH_DEALERSHIP_PAYABLE", { deliveredAt: DELIVERED })).toMatchObject({
      dueAt: null,
      rule: "CLEARED_PROCEEDS_NOT_RECORDED",
    });
  });

  test("OWNED ON_ACCOUNT payable with no agreed terms has no due date", () => {
    expect(deriveDueDate("OWNED_ON_ACCOUNT_PAYABLE", {})).toMatchObject({
      dueAt: null,
      rule: "TERMS_NOT_RECORDED",
    });
  });

  test("cost recovery with no agreed date has no due date; collectibility is not recorded", () => {
    expect(deriveDueDate("COST_RECOVERY", { deliveredAt: DELIVERED })).toMatchObject({
      dueAt: null,
      rule: "COLLECTIBILITY_NOT_RECORDED",
    });
  });

  test("a non-finite or negative recorded fact is a missing fact, never a date", () => {
    expect(deriveDueDate("SOURCED_DIRECT_RECEIVABLE", { deliveredAt: Number.NaN }).dueAt).toBeNull();
    expect(deriveDueDate("SOURCED_DIRECT_RECEIVABLE", { deliveredAt: -1 }).dueAt).toBeNull();
    expect(deriveDueDate("COST_RECOVERY", { agreedDueAt: Number.POSITIVE_INFINITY }).dueAt).toBeNull();
    expect(deriveDueDate("COST_RECOVERY", { agreedDueAt: 0 }).dueAt).toBeNull();
  });

  test("every missing-fact outcome ages as NO_DUE_DATE, never overdue, however far in the future now is", () => {
    const far = utc("2099-01-01T00:00:00Z");
    for (const model of Object.keys(DUE_TRIGGERS) as (keyof typeof DUE_TRIGGERS)[]) {
      const derived = deriveDueDate(model, {});
      expect(derived.dueAt).toBeNull();
      expect(agingFor(derived.dueAt, far).bucket).toBe("NO_DUE_DATE");
    }
  });
});
