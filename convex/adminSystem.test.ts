import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.useRealTimers();
});

test("webhook inbox keeps one row per event across claim, duplicate, and completion", async () => {
  const t = convexTest(schema, MODULES);

  const first = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "clerk",
    summary: "user.created",
    eventId: "evt_1",
    payloadSha256: "hash_1",
    rawPayload: '{"id":"evt_1"}',
    payloadPreview: '{"id":"evt_1"}',
    payloadTruncated: false,
  });
  expect(first.disposition).toBe("process");

  // Concurrent duplicate delivery while the first claim is in flight — must
  // not be handed out for processing a second time.
  const duplicate = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "clerk",
    summary: "user.created retry",
    eventId: "evt_1",
  });
  expect(duplicate.disposition).toBe("skip_in_flight");
  expect(duplicate.logId).toEqual(first.logId);

  await t.mutation(internal.adminSystem.webhookInboxComplete, {
    logId: first.logId,
    claimedAt: first.claimedAt!,
    outcome: "success",
  });

  // Redelivery after successful processing — idempotent ack, no reprocessing.
  const afterSuccess = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "clerk",
    summary: "user.created redelivery",
    eventId: "evt_1",
  });
  expect(afterSuccess.disposition).toBe("skip_processed");

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "clerk").eq("eventId", "evt_1"),
      )
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "success",
    receiveCount: 3,
  });
});

test("failed webhook deliveries are reclaimed and can complete on redelivery", async () => {
  const t = convexTest(schema, MODULES);

  const first = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "whatsapp",
    summary: "Message wamid.1",
    eventId: "wamid.1",
  });
  expect(first.disposition).toBe("process");

  await t.mutation(internal.adminSystem.webhookInboxComplete, {
    logId: first.logId,
    claimedAt: first.claimedAt!,
    outcome: "error",
    error: "downstream mutation failed",
  });

  // Provider redelivers after our non-2xx response — the same row is
  // reclaimed for another processing attempt.
  const retry = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "whatsapp",
    summary: "Message wamid.1",
    eventId: "wamid.1",
  });
  expect(retry.disposition).toBe("process");
  expect(retry.logId).toEqual(first.logId);

  await t.mutation(internal.adminSystem.webhookInboxComplete, {
    logId: retry.logId,
    claimedAt: retry.claimedAt!,
    outcome: "success",
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "whatsapp").eq("eventId", "wamid.1"),
      )
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("success");
  expect(rows[0].error).toBeUndefined();
});

test("stale in-flight claims are reclaimed after the lease expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));

  const t = convexTest(schema, MODULES);

  const first = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "facebook",
    summary: "Batch with 3 entries",
    eventId: "sha_abc",
  });
  expect(first.disposition).toBe("process");

  // Within the lease window the claim is honored…
  vi.setSystemTime(new Date("2026-07-01T10:04:00Z"));
  const early = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "facebook",
    summary: "Batch with 3 entries",
    eventId: "sha_abc",
  });
  expect(early.disposition).toBe("skip_in_flight");

  // …after it expires (handler crashed mid-processing), redelivery reclaims.
  vi.setSystemTime(new Date("2026-07-01T10:06:01Z"));
  const reclaimed = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "facebook",
    summary: "Batch with 3 entries",
    eventId: "sha_abc",
  });
  expect(reclaimed.disposition).toBe("process");
  expect(reclaimed.logId).toEqual(first.logId);
  expect(reclaimed.claimedAt).not.toEqual(first.claimedAt);
});

test("stale webhook completion cannot overwrite a reclaimed attempt", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));

  const t = convexTest(schema, MODULES);

  const first = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "instagram",
    summary: "Batch with 1 entry",
    eventId: "ig_batch",
  });
  expect(first.disposition).toBe("process");

  vi.setSystemTime(new Date("2026-07-01T10:06:01Z"));
  const reclaimed = await t.mutation(internal.adminSystem.webhookInboxIntake, {
    source: "instagram",
    summary: "Batch with 1 entry retry",
    eventId: "ig_batch",
  });
  expect(reclaimed.disposition).toBe("process");

  await t.mutation(internal.adminSystem.webhookInboxComplete, {
    logId: first.logId,
    claimedAt: first.claimedAt!,
    outcome: "success",
  });

  let row = await t.run((ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "instagram").eq("eventId", "ig_batch"),
      )
      .unique(),
  );
  expect(row?.status).toBe("received");

  await t.mutation(internal.adminSystem.webhookInboxComplete, {
    logId: reclaimed.logId,
    claimedAt: reclaimed.claimedAt!,
    outcome: "error",
    error: "retry failed",
  });

  row = await t.run((ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "instagram").eq("eventId", "ig_batch"),
      )
      .unique(),
  );
  expect(row?.status).toBe("error");
  expect(row?.error).toBe("retry failed");
});
