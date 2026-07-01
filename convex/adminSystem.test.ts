import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.*s");

test("webhook received logs are deduplicated by source and event id", async () => {
  const t = convexTest(schema, MODULES);

  await t.mutation(internal.adminSystem.logWebhookEvent, {
    source: "clerk",
    status: "received",
    summary: "user.created",
    eventId: "evt_1",
    payloadSha256: "hash_1",
    rawPayload: '{"id":"evt_1"}',
    payloadPreview: '{"id":"evt_1"}',
    payloadTruncated: false,
  });

  await t.mutation(internal.adminSystem.logWebhookEvent, {
    source: "clerk",
    status: "received",
    summary: "user.created retry",
    eventId: "evt_1",
    payloadSha256: "hash_2",
    rawPayload: '{"id":"evt_1","retry":true}',
    payloadPreview: '{"id":"evt_1","retry":true}',
    payloadTruncated: false,
  });

  const receivedLogs = await t.run(async (ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "clerk").eq("eventId", "evt_1"),
      )
      .collect(),
  );

  expect(receivedLogs).toHaveLength(1);
  expect(receivedLogs[0]).toMatchObject({
    source: "clerk",
    status: "received",
    summary: "user.created retry",
    eventId: "evt_1",
    payloadSha256: "hash_2",
    rawPayload: '{"id":"evt_1","retry":true}',
    receiveCount: 2,
  });

  await t.mutation(internal.adminSystem.logWebhookEvent, {
    source: "clerk",
    status: "success",
    summary: "user.created",
    eventId: "evt_1",
  });

  const allEventLogs = await t.run(async (ctx) =>
    ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", "clerk").eq("eventId", "evt_1"),
      )
      .collect(),
  );

  expect(allEventLogs.map((log) => log.status).sort()).toEqual([
    "received",
    "success",
  ]);
});
