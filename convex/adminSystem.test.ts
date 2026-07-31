import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { CRON_HEARTBEAT_JOBS } from "./constants";

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

// ─── Operational-log retention ───────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

/** Seeds an allowlisted super-admin and returns an identity-bound client. */
async function asSuperAdmin(t: ReturnType<typeof convexTest>) {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "admin_clerk", email: "admin@autoflow.dev" }),
  );
  return t.withIdentity({ subject: "admin_clerk" });
}

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

/** Inserts a heartbeat directly so tests can place rows at arbitrary ages. */
async function seedHeartbeat(
  t: ReturnType<typeof convexTest>,
  jobName: string,
  ranAt: number,
) {
  return await t.run((ctx) =>
    ctx.db.insert("cronHeartbeats", { jobName, ranAt, success: true, detail: "seeded" }),
  );
}

test("every cron that writes a heartbeat is listed in CRON_HEARTBEAT_JOBS", async () => {
  // getCronStatus reads by name instead of scanning the table, so a job whose
  // name is missing from the constant silently disappears from the admin panel.
  // Guard the constant against the actual insert sites, not against a comment.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const convexDir = path.join(process.cwd(), "convex");
  const entries = await fs.readdir(convexDir, { recursive: true });

  // Whole directory, not just crons.ts — a heartbeat inserted from any other
  // Convex module has exactly the same failure mode.
  const inserted: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    if (entry.split(path.sep).includes("_generated")) continue;
    const source = await fs.readFile(path.join(convexDir, entry), "utf8");
    inserted.push(
      ...Array.from(
        source.matchAll(/insert\(\s*"cronHeartbeats"\s*,\s*\{[\s\S]*?jobName:\s*"([^"]+)"/g),
      ).map((m) => m[1]),
    );
  }

  expect(inserted.length).toBeGreaterThan(0);
  for (const jobName of inserted) {
    expect(CRON_HEARTBEAT_JOBS as readonly string[]).toContain(jobName);
  }
});

test("getCronStatus returns the newest heartbeat per job without scanning the table", async () => {
  const t = convexTest(schema, MODULES);
  const now = Date.now();

  await seedHeartbeat(t, "check-upcoming-tasks", now - 3 * DAY_MS);
  await seedHeartbeat(t, "check-upcoming-tasks", now - 60_000);
  await seedHeartbeat(t, "check-upcoming-tasks", now - DAY_MS);

  const admin = await asSuperAdmin(t);
  const status = await admin.query(api.adminSystem.getCronStatus, {});

  expect(status).toHaveLength(1);
  expect(status[0].jobName).toBe("check-upcoming-tasks");
  expect(status[0].ranAt).toBe(now - 60_000);
});

test("pruneOperationalLogs deletes aged rows, keeps recent ones and the newest heartbeat per job", async () => {
  const t = convexTest(schema, MODULES);
  const now = Date.now();

  // Two rows past the 7-day heartbeat window and one inside it.
  await seedHeartbeat(t, "check-upcoming-tasks", now - 30 * DAY_MS);
  await seedHeartbeat(t, "check-upcoming-tasks", now - 9 * DAY_MS);
  await seedHeartbeat(t, "check-upcoming-tasks", now - 60_000);

  // A job whose only heartbeat predates the window must survive, or its admin
  // row would vanish permanently.
  await seedHeartbeat(t, "monthly-only-job", now - 45 * DAY_MS);

  await t.run(async (ctx) => {
    await ctx.db.insert("webhookLogs", {
      source: "clerk",
      status: "success",
      summary: "aged out",
      createdAt: now - 45 * DAY_MS,
    });
    await ctx.db.insert("webhookLogs", {
      source: "clerk",
      status: "success",
      summary: "still in window",
      createdAt: now - DAY_MS,
    });
  });

  const result = await t.mutation(internal.adminSystem.pruneOperationalLogs, {});
  expect(result).toEqual({ heartbeatsDeleted: 2, webhookLogsDeleted: 1 });

  const remaining = await t.run((ctx) => ctx.db.query("cronHeartbeats").collect());
  expect(remaining.map((r) => r.ranAt).sort((a, b) => a - b)).toEqual(
    [now - 45 * DAY_MS, now - 60_000].sort((a, b) => a - b),
  );

  const remainingLogs = await t.run((ctx) => ctx.db.query("webhookLogs").collect());
  expect(remainingLogs.map((r) => r.summary)).toEqual(["still in window"]);
});

test("getOverview returns a capped count and a truncation flag per table", async () => {
  const t = convexTest(schema, MODULES);

  const admin = await asSuperAdmin(t);
  const overview = await admin.query(api.adminSystem.getOverview, {});

  // Shape contract the admin KPI tiles depend on: a count plus a truncation
  // flag, never a bare number.
  for (const stat of Object.values(overview)) {
    expect(stat).toEqual({ count: expect.any(Number), truncated: expect.any(Boolean) });
  }
  expect(overview.organizations).toEqual({ count: 0, truncated: false });
  // The seeded super-admin is the only user row.
  expect(overview.users).toEqual({ count: 1, truncated: false });
});
