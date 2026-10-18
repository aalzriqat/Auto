import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";

// Scheduled notification senders call `rateLimiter.limit`; the component is
// opt-in in the harness, so stub it the way the other suites that drain the
// scheduler do.
vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

const NOW = 1_800_000_000_000;
const MINUTE_MS = 60 * 1000;
const WINDOW_MS = 15 * MINUTE_MS;
/**
 * Mirrors ALARM_BATCH_SIZE in crons.ts: the per-bucket read AND the per-hop task
 * cap. It is derived there from the scheduled-function budget:
 * floor((800 - 20 sweep - 1 continuation) / (4 dispatch sends + 1 email + 1 child)).
 */
const BATCH = 129;
/**
 * Mirrors SCHEDULED_BUDGET in crons.ts: the most functions any one alarm
 * transaction may schedule, kept well under the platform's 1,000.
 */
const BUDGET = 800;
/** Four channel sends per manager, as DISPATCH_MAX_SCHEDULED pins in notifications.test.ts. */
const SENDS_PER_MANAGER = 4;
/**
 * Mirrors MANAGER_PAGE_SIZE in crons.ts: memberships one delivery page covers.
 * floor((800 - 1 next-page kick) / 4): a full page of 199 managers schedules 797.
 */
const PAGE = 199;
/** Mirrors STALLED_DELIVERY_MS in crons.ts. */
const STALLED_MS = 15 * MINUTE_MS;
/** Mirrors MAX_DELIVERY_REKICKS in crons.ts: re-kicks a delivery gets without progress before it is parked as FAILED. */
const MAX_REKICKS = 5;
/** The pre-SCRUM-807 scan cap per bucket. A future-dated backlog this big used to starve due tasks. */
const OLD_SCAN_CAP = 500;
/** `udfPath`s of this cron's own scheduled entries in `_scheduled_functions`. */
const CONTINUATION = "crons:triggerAlarms";
const DELIVERY = "crons:deliverTaskAlarmToManagers";
const IDLE = { continuations: 0, deliveries: 0, other: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type TestConvex = ReturnType<typeof convexTestWithComponents<typeof schema>>;

interface OrgFixture {
  orgId: Id<"organizations">;
  assigneeId: Id<"users">;
  managerRoleId: Id<"roles">;
  salesRoleId: Id<"roles">;
  /** Members holding MANAGE_USERS, in membership order. */
  managerIds: Id<"users">[];
}

let seedCounter = 0;

/**
 * An org with an assignee, `managers` members holding MANAGE_USERS and
 * `otherMembers` members who do not, seeded in that order. Every user has an empty
 * email so no email/WhatsApp fan-out is scheduled unless `allChannels` opts the
 * managers (or `assigneeAllChannels` the assignee) into every channel: the worst
 * case `dispatch` can produce for one recipient.
 */
async function seedOrg(
  t: TestConvex,
  options: {
    managers?: number;
    otherMembers?: number;
    allChannels?: boolean;
    assigneeAllChannels?: boolean;
  } = {}
): Promise<OrgFixture> {
  const tag = `o${seedCounter++}`;
  const core = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: `Alarm Dealer ${tag}`, createdAt: NOW });
    const assigneeId = await ctx.db.insert("users", {
      clerkId: `${tag}_assignee`,
      email: options.assigneeAllChannels ? `${tag}-assignee@test.com` : "",
      name: "Assignee",
      ...(options.assigneeAllChannels ? { whatsappPhone: "+962790000000" } : {}),
    });
    const managerRoleId = await ctx.db.insert("roles", {
      orgId,
      name: "MANAGER",
      permissions: [PERMISSIONS.MANAGE_USERS],
    });
    const salesRoleId = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] });
    if (options.allChannels || options.assigneeAllChannels) {
      // The WhatsApp plan gate is only consulted for a recipient who enabled it.
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    if (options.assigneeAllChannels) {
      await ctx.db.insert("notificationPreferences", {
        orgId,
        userId: assigneeId,
        category: "operations",
        emailEnabled: true,
        whatsappEnabled: true,
        pushEnabled: true,
      });
      await ctx.db.insert("mobilePushTokens", {
        userId: assigneeId,
        token: `ExponentPushToken[${tag}-assignee]`,
        platform: "IOS",
        createdAt: NOW,
        lastSeenAt: NOW,
      });
    }
    return { orgId, assigneeId, managerRoleId, salesRoleId };
  });
  const org: OrgFixture = { ...core, managerIds: [] };
  await addMembers(t, org, "manager", options.managers ?? 0, options.allChannels ?? false);
  await addMembers(t, org, "member", options.otherMembers ?? 0, false);
  return org;
}

/**
 * Appends memberships to the org. Membership inserts run aggregate triggers, and a
 * few hundred in one transaction trip the harness's own index-range ceiling, so
 * they are seeded in chunks.
 */
async function addMembers(
  t: TestConvex,
  org: OrgFixture,
  kind: "manager" | "member",
  count: number,
  allChannels: boolean
) {
  const chunk = allChannels ? 40 : 100;
  for (let start = 0; start < count; start += chunk) {
    const ids = await t.run(async (ctx) => {
      const created: Id<"users">[] = [];
      for (let i = start; i < Math.min(start + chunk, count); i++) {
        const n = seedCounter++;
        const userId = await ctx.db.insert("users", {
          clerkId: `${kind}_${n}`,
          email: allChannels ? `${kind}${n}@test.com` : "",
          name: `${kind} ${n}`,
          ...(allChannels ? { whatsappPhone: `+9627900${String(n).padStart(5, "0")}` } : {}),
        });
        await ctx.db.insert("memberships", {
          orgId: org.orgId,
          userId,
          roleId: kind === "manager" ? org.managerRoleId : org.salesRoleId,
        });
        if (allChannels) {
          await ctx.db.insert("notificationPreferences", {
            orgId: org.orgId,
            userId,
            category: "operations",
            emailEnabled: true,
            whatsappEnabled: true,
            pushEnabled: true,
          });
          await ctx.db.insert("mobilePushTokens", {
            userId,
            token: `ExponentPushToken[${kind}-${n}]`,
            platform: "IOS",
            createdAt: NOW,
            lastSeenAt: NOW,
          });
        }
        created.push(userId);
      }
      return created;
    });
    if (kind === "manager") org.managerIds.push(...ids);
  }
}

type Alarm = "unset" | "false" | "true";

async function seedTasks(
  t: TestConvex,
  org: Pick<OrgFixture, "orgId" | "assigneeId">,
  specs: Array<{
    dueDate: number;
    title?: string;
    alarm?: Alarm;
    status?: "PENDING" | "COMPLETED" | "CANCELLED";
  }>
) {
  return await t.run(async (ctx) => {
    const ids: Id<"tasks">[] = [];
    for (const [i, spec] of specs.entries()) {
      ids.push(
        await ctx.db.insert("tasks", {
          orgId: org.orgId,
          assignedTo: org.assigneeId,
          title: spec.title ?? `Task ${i}`,
          dueDate: spec.dueDate,
          status: spec.status ?? "PENDING",
          ...(spec.alarm === "false" ? { alarmTriggered: false } : {}),
          ...(spec.alarm === "true" ? { alarmTriggered: true } : {}),
        })
      );
    }
    return ids;
  });
}

async function alarmState(t: TestConvex, taskId: Id<"tasks">) {
  return (await t.run((ctx) => ctx.db.get(taskId)))?.alarmTriggered;
}

/** Flagged task ids among `ids`, from one read of the tasks. */
async function flaggedAmong(t: TestConvex, ids: Id<"tasks">[]) {
  const wanted = new Set<string>(ids);
  const rows = await t.run((ctx) => ctx.db.query("tasks").collect());
  return rows.filter((row) => wanted.has(row._id) && row.alarmTriggered === true).map((row) => row._id);
}

/**
 * One pass over `notifications`: assignee alerts per task, and manager warnings per
 * task title (warnings carry no `relatedTaskId`; seeded titles are unique within a
 * test) with who received them and in which org. Collecting once keeps assertions
 * over hundreds of tasks linear.
 */
async function notificationCounts(t: TestConvex) {
  const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
  const dueSoon = new Map<string, number>();
  const warnings = new Map<string, number>();
  const recipients = new Map<string, Map<string, number>>();
  const orgs = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.type === "task.due_soon" && row.relatedTaskId) {
      dueSoon.set(row.relatedTaskId, (dueSoon.get(row.relatedTaskId) ?? 0) + 1);
    } else if (row.type === "task.overdue_warning") {
      const title = String(row.data?.taskTitle);
      warnings.set(title, (warnings.get(title) ?? 0) + 1);
      const perUser = recipients.get(title) ?? new Map<string, number>();
      perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
      recipients.set(title, perUser);
      orgs.set(title, (orgs.get(title) ?? new Set<string>()).add(row.orgId));
    }
  }
  return { dueSoon, warnings, recipients, orgs, total: rows.length };
}

/** What `title`'s warnings reached: one notification to each of `managerIds`, nobody else, all in `orgId`. */
function expectDeliveredOnce(
  counts: Awaited<ReturnType<typeof notificationCounts>>,
  title: string,
  org: OrgFixture,
  times = 1
) {
  expect(counts.recipients.get(title)).toEqual(new Map(org.managerIds.map((id) => [id, times])));
  expect(counts.orgs.get(title)).toEqual(new Set([org.orgId]));
}

/** Pending scheduled work, split into this cron's own entries and everything else (sender actions). */
async function pendingScheduled(t: TestConvex) {
  const rows = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const pending = rows.filter((row) => row.state.kind === "pending");
  const continuations = pending.filter((row) => row.name === CONTINUATION).length;
  const deliveries = pending.filter((row) => row.name === DELIVERY).length;
  return { continuations, deliveries, other: pending.length - continuations - deliveries };
}

async function scheduledTotal(t: TestConvex) {
  const { continuations, deliveries, other } = await pendingScheduled(t);
  return continuations + deliveries + other;
}

async function deliveryRows(t: TestConvex) {
  // Existing queue assertions cover unfinished/failed work. Retention assertions
  // below read terminal records directly by their original IDs.
  return await t.run(async (ctx) =>
    (await ctx.db.query("taskAlarmDeliveries").collect())
      .filter((row) => row.status === "ACTIVE" || row.status === "FAILED")
  );
}

/**
 * A duplicate preference row makes dispatch's `.unique()` read throw for that
 * manager: a page that fails deterministically, after the managers before it on the
 * page have already been dispatched inside the same transaction.
 */
async function poisonManager(t: TestConvex, org: OrgFixture, index: number) {
  await t.run(async (ctx) => {
    for (let copy = 0; copy < 2; copy++) {
      await ctx.db.insert("notificationPreferences", {
        orgId: org.orgId,
        userId: org.managerIds[index],
        category: "operations",
        emailEnabled: false,
        whatsappEnabled: false,
        pushEnabled: false,
      });
    }
  });
}

/** The alarm cron's heartbeats, oldest first. */
async function alarmHeartbeats(t: TestConvex) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("cronHeartbeats")
      .withIndex("by_job_ranAt", (q) => q.eq("jobName", "check-upcoming-tasks"))
      .collect()
  );
  return rows.map((row) => ({ success: row.success, detail: row.detail ?? "" }));
}

/**
 * Runs the delivery pages by hand, one transaction each and WITHOUT running the
 * sender actions they schedule, so each page's own scheduling is visible. `only`
 * restricts it to one org's deliveries. Returns the scheduled functions each page
 * added.
 */
async function driveDeliveries(t: TestConvex, only?: Id<"organizations">) {
  const added: number[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const rows = (await deliveryRows(t)).filter((row) => !only || row.orgId === only);
    if (rows.length === 0) return added;
    const before = await scheduledTotal(t);
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: rows[0]._id });
    added.push((await scheduledTotal(t)) - before);
  }
  throw new Error("deliveries did not finish");
}

function triggeredCount(summary: string) {
  return Number(/Triggered alarms for (\d+) tasks\./.exec(summary)?.[1]);
}

describe("triggerAlarms", () => {
  test("alarms exactly the PENDING, un-alarmed tasks due within 15 minutes, once", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t, { managers: 1 });
    const [atEdge, pastEdge, overdue, falseFlag, already, completed, cancelled] = await seedTasks(t, org, [
      { dueDate: NOW + WINDOW_MS }, // inclusive edge
      { dueDate: NOW + WINDOW_MS + 1 }, // one ms outside
      { dueDate: NOW - 86_400_000 }, // long overdue still alarms once
      { dueDate: NOW + 1_000, alarm: "false" },
      { dueDate: NOW + 1_000, alarm: "true" },
      { dueDate: NOW + 1_000, status: "COMPLETED" },
      { dueDate: NOW + 1_000, status: "CANCELLED" },
    ]);

    const result = await t.mutation(internal.crons.triggerAlarms, {});
    expect(result).toBe("Triggered alarms for 3 tasks.");

    expect(await alarmState(t, atEdge)).toBe(true);
    expect(await alarmState(t, pastEdge)).toBeUndefined();
    expect(await alarmState(t, overdue)).toBe(true);
    expect(await alarmState(t, falseFlag)).toBe(true);
    expect(await alarmState(t, already)).toBe(true);
    expect(await alarmState(t, completed)).toBeUndefined();
    expect(await alarmState(t, cancelled)).toBeUndefined();

    // The assignee is alerted in the same transaction that flags the task;
    // managers are notified by the delivery the task left behind.
    expect((await notificationCounts(t)).dueSoon).toEqual(
      new Map([
        [atEdge, 1],
        [overdue, 1],
        [falseFlag, 1],
      ])
    );
    expect(await deliveryRows(t)).toHaveLength(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // An already-alarmed or out-of-window task is not notified at all, and the
    // managers are warned once per fired task.
    const counts = await notificationCounts(t);
    expect(counts.dueSoon.size).toBe(3);
    expect(counts.warnings.size).toBe(3);
    expect([...counts.warnings.values()]).toEqual([1, 1, 1]);
    expect(counts.total).toBe(6);
    expect(await deliveryRows(t)).toHaveLength(0);

    // The heartbeat is unchanged.
    const beats = await t.run((ctx) => ctx.db.query("cronHeartbeats").collect());
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ jobName: "check-upcoming-tasks", success: true, detail: result });

    // A second run finds nothing and schedules nothing.
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 0 tasks.");
    expect(await pendingScheduled(t)).toEqual(IDLE);
  });

  test("a task whose alarm was re-armed (reschedule or re-open) alarms again", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t);
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW + 1_000 }]);

    await t.mutation(internal.crons.triggerAlarms, {});
    expect((await notificationCounts(t)).dueSoon.get(taskId)).toBe(1);

    // convex/tasks.ts resets `alarmTriggered` to false on reschedule / re-open.
    await t.run((ctx) => ctx.db.patch(taskId, { alarmTriggered: false, dueDate: NOW + 5_000 }));
    await t.mutation(internal.crons.triggerAlarms, {});
    expect((await notificationCounts(t)).dueSoon.get(taskId)).toBe(2);
  });

  test.each([
    ["never flagged", "unset"],
    ["explicitly false", "false"],
  ] as const)(
    "a due task is not starved behind a large future-dated backlog (%s bucket)",
    async (_label, alarm) => {
      const t = convexTestWithComponents(schema, MODULES);
      const org = await seedOrg(t);
      // Older untriggered tasks, due far in the future, created FIRST: they sort
      // ahead of every later task in the (status, alarmTriggered) index and used to
      // fill the whole scan window.
      await seedTasks(
        t,
        org,
        Array.from({ length: OLD_SCAN_CAP + 1 }, (_, i) => ({ dueDate: NOW + 30 * 86_400_000 + i, alarm }))
      );
      const [dueTaskId] = await seedTasks(t, org, [{ dueDate: NOW + 60_000, alarm }]);

      await t.mutation(internal.crons.triggerAlarms, {});

      expect(await alarmState(t, dueTaskId)).toBe(true);
      const counts = await notificationCounts(t);
      expect(counts.dueSoon).toEqual(new Map([[dueTaskId, 1]]));
    }
  );

  test("one run is bounded per bucket, and its continuation drains the rest exactly once", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t);
    const ids = await seedTasks(
      t,
      org,
      Array.from({ length: BATCH + 1 }, (_, i) => ({ dueDate: NOW - 60_000 + i }))
    );

    await t.mutation(internal.crons.triggerAlarms, {});

    // One hop alarms at most one batch, due-soonest first; the remainder is left
    // for the continuation instead of being read into the same transaction.
    expect(await flaggedAmong(t, ids)).toHaveLength(BATCH);
    expect(await alarmState(t, ids[BATCH])).toBeUndefined();
    expect((await pendingScheduled(t)).continuations).toBe(1);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await flaggedAmong(t, ids)).toHaveLength(BATCH + 1);
    const counts = await notificationCounts(t);
    expect(counts.dueSoon).toEqual(new Map(ids.map((id) => [id, 1])));
    expect(await pendingScheduled(t)).toEqual(IDLE);
  });

  test("the cap holds when both buckets are full: soonest-due first across them", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t);
    // Interleaved due times across the two buckets: the merged order, not each
    // bucket's own, decides which BATCH tasks this hop takes.
    const specs = Array.from({ length: BATCH * 2 }, (_, i) => ({
      dueDate: NOW - 600_000 + i,
      alarm: i % 2 === 0 ? ("unset" as const) : ("false" as const),
    }));
    const ids = await seedTasks(t, org, specs);

    await t.mutation(internal.crons.triggerAlarms, {});

    const flagged = new Set<string>(await flaggedAmong(t, ids));
    expect(flagged.size).toBe(BATCH);
    for (const [i, id] of ids.entries()) expect(flagged.has(id)).toBe(i < BATCH);
    expect((await pendingScheduled(t)).continuations).toBe(1);
  });

  test("a continuation chain terminates when the due set is exactly one full batch", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t);
    const ids = await seedTasks(
      t,
      org,
      Array.from({ length: BATCH }, (_, i) => ({ dueDate: NOW - 60_000 + i, alarm: "false" as const }))
    );

    await t.mutation(internal.crons.triggerAlarms, {});
    // finishAllScheduledFunctions only returns once the scheduler is idle, so
    // an unending chain would not get past this line.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const counts = await notificationCounts(t);
    expect(counts.dueSoon).toEqual(new Map(ids.map((id) => [id, 1])));
    expect(await pendingScheduled(t)).toEqual(IDLE);
  });
});

// SCRUM-807 — a due task used to notify its org's whole manager cohort inside the
// transaction that flagged it, so one big cohort could not fit and, as the head of
// the due-soonest queue, stopped every other tenant's alarms. The cohort is now
// delivered by `deliverTaskAlarmToManagers`, a page of memberships per
// transaction with its progress in `taskAlarmDeliveries`.
//
// These run with the harness's modelled per-transaction ceilings ENFORCED (4,096
// db reads, 32,000 documents, 1,000 scheduled functions). convex-test exposes no
// usage counters, serialises transactions (so concurrent-OCC behaviour is NOT
// exercised) and is not the production platform: "resolves under the ceilings" is
// the only signal, and it is not platform proof.
describe("task alarm manager delivery under per-transaction ceilings", { timeout: 120_000 }, () => {
  const limited = () => convexTestWithComponents(schema, MODULES, { transactionLimits: true });

  test("60 members / 3 managers / 100 due tasks: one hop flags them all, delivery follows, each manager warned once", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 3, otherMembers: 57 });
    const ids = await seedTasks(
      t,
      org,
      Array.from({ length: 100 }, (_, i) => ({ dueDate: NOW - 60_000 + i }))
    );

    await t.mutation(internal.crons.triggerAlarms, {});

    // The hop never touches the cohort, so its size does not limit the hop. Each
    // flagged task left exactly one delivery behind, in the same transaction.
    expect(await flaggedAmong(t, ids)).toHaveLength(100);
    expect((await pendingScheduled(t)).continuations).toBe(0);
    const rows = await deliveryRows(t);
    expect(rows.map((row) => row.taskId).sort()).toEqual([...ids].sort());
    expect(rows.every((row) => row.cursor === null && row.orgId === org.orgId)).toBe(true);
    const mid = await notificationCounts(t);
    expect(mid.dueSoon).toEqual(new Map(ids.map((id) => [id, 1])));
    expect(mid.warnings.size).toBe(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const done = await notificationCounts(t);
    expect(done.warnings).toEqual(new Map(ids.map((_, i) => [`Task ${i}`, 3])));
    for (const [i] of ids.entries()) expectDeliveredOnce(done, `Task ${i}`, org);
    expect(done.total).toBe(100 * (1 + 3));
    expect(await deliveryRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toEqual(IDLE);
  });

  test("a cohort spread over several pages is paged by cursor: managers on every page are warned once, in order", async () => {
    const t = limited();
    // 3 managers, 397 others, 3 managers: three pages of 199/199/5 with managers
    // on the first and the last.
    const org = await seedOrg(t, { managers: 3, otherMembers: 397 });
    await addMembers(t, org, "manager", 3, false);
    const ids = await seedTasks(
      t,
      org,
      Array.from({ length: 5 }, (_, i) => ({ dueDate: NOW - 60_000 + i }))
    );
    await t.mutation(internal.crons.triggerAlarms, {});

    // One page of one delivery: the cursor advances and the rest is still owed.
    const [first] = await deliveryRows(t);
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: first._id });
    const advanced = await t.run((ctx) => ctx.db.get(first._id));
    expect(advanced?.cursor).toEqual(expect.any(String));

    await driveDeliveries(t);

    const counts = await notificationCounts(t);
    for (const [i] of ids.entries()) expectDeliveredOnce(counts, `Task ${i}`, org);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("an oversized cohort (more sends than one transaction may schedule) is delivered in bounded pages, each recipient once", async () => {
    const t = limited();
    // 300 managers x 4 channels = 1,200 sends for ONE task, over the 1,000
    // ceiling: it can only be delivered across transactions.
    const org = await seedOrg(t, { managers: 300, allChannels: true });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Oversized" }]);

    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 1 tasks.");
    expect(await alarmState(t, taskId)).toBe(true);
    expect(await deliveryRows(t)).toHaveLength(1);
    const sendsBefore = (await pendingScheduled(t)).other;

    const added = await driveDeliveries(t);

    // Two pages (199 + 101), each inside the budget: 199 x 4 sends plus the next
    // page's kick is 797, then the last 101 x 4.
    expect(added).toHaveLength(2);
    expect(added[0]).toBe(PAGE * SENDS_PER_MANAGER + 1);
    expect(Math.max(...added)).toBeLessThanOrEqual(BUDGET);
    expect((await pendingScheduled(t)).other - sendsBefore).toBe(300 * 4);
    expectDeliveredOnce(await notificationCounts(t), "Oversized", org);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("two orgs: an oversized cohort at the head of the queue does not hold back another org's alarm", async () => {
    const t = limited();
    const big = await seedOrg(t, { managers: 300, allChannels: true });
    const small = await seedOrg(t, { managers: 3 });
    // The oversized org's task is due FIRST, so it heads the due-soonest queue.
    const [bigTask] = await seedTasks(t, big, [{ dueDate: NOW - 2_000, title: "Big org task" }]);
    const [smallTask] = await seedTasks(t, small, [{ dueDate: NOW - 1_000, title: "Small org task" }]);

    // One run alarms both: the head task is not a poison pill.
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 2 tasks.");
    expect(await alarmState(t, bigTask)).toBe(true);
    expect(await alarmState(t, smallTask)).toBe(true);

    // The small org is fully served while the big org's delivery has not run a
    // single page.
    await driveDeliveries(t, small.orgId);
    let counts = await notificationCounts(t);
    expectDeliveredOnce(counts, "Small org task", small);
    expect(counts.warnings.get("Big org task")).toBeUndefined();
    expect(await deliveryRows(t)).toEqual([expect.objectContaining({ orgId: big.orgId, cursor: null })]);

    await driveDeliveries(t, big.orgId);

    // Each org's managers, and only they, got their own org's warning.
    counts = await notificationCounts(t);
    expectDeliveredOnce(counts, "Big org task", big);
    expectDeliveredOnce(counts, "Small org task", small);
    expect(counts.warnings.get("Small org task")).toBe(3);
    expect(counts.warnings.get("Big org task")).toBe(300);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("a re-armed task warns the managers again in full, not a duplicate of the first alarm", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 5 });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW + 1_000, title: "Rearmed" }]);

    await t.mutation(internal.crons.triggerAlarms, {});
    await driveDeliveries(t);
    expectDeliveredOnce(await notificationCounts(t), "Rearmed", org, 1);

    // convex/tasks.ts resets `alarmTriggered` on reschedule / re-open.
    await t.run((ctx) => ctx.db.patch(taskId, { alarmTriggered: false, dueDate: NOW + 5_000 }));
    await t.mutation(internal.crons.triggerAlarms, {});
    await driveDeliveries(t);

    const counts = await notificationCounts(t);
    expectDeliveredOnce(counts, "Rearmed", org, 2);
    expect(counts.dueSoon.get(taskId)).toBe(2);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("a task re-armed while its first delivery is mid-cohort gets an independent second delivery", async () => {
    const t = limited();
    // 250 managers: two pages, so the first delivery can be caught half way.
    const org = await seedOrg(t, { managers: 250 });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW + 1_000, title: "Mid rearm" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    const [first] = await deliveryRows(t);
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: first._id });
    expect((await t.run((ctx) => ctx.db.get(first._id)))?.cursor).toEqual(expect.any(String));

    await t.run((ctx) => ctx.db.patch(taskId, { alarmTriggered: false, dueDate: NOW + 5_000 }));
    await t.mutation(internal.crons.triggerAlarms, {});
    expect(await deliveryRows(t)).toHaveLength(2);

    await driveDeliveries(t);

    // Two alarms fired, so every manager is warned exactly twice: once per alarm,
    // nobody missed by the half-finished first delivery and nobody third-warned.
    expectDeliveredOnce(await notificationCounts(t), "Mid rearm", org, 2);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("a delivery whose continuation was lost is re-queued after the stall window and still delivers each recipient once", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 250 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Lost kick" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    expect(await deliveryRows(t)).toHaveLength(1);
    // The scheduled kick never runs (fake timers: nothing fires on its own).
    expect((await pendingScheduled(t)).deliveries).toBe(1);

    // Inside the window nothing is re-queued: a slow-but-live delivery is not duplicated.
    vi.setSystemTime(NOW + STALLED_MS - MINUTE_MS);
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 0 tasks.");
    expect((await pendingScheduled(t)).deliveries).toBe(1);

    // Past it the cron re-kicks the delivery.
    vi.setSystemTime(NOW + STALLED_MS + MINUTE_MS);
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toMatch(/Re-queued 1 stalled/);
    expect((await pendingScheduled(t)).deliveries).toBe(2);
    // ...and re-kicking does not re-kick again on the next tick.
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 0 tasks.");

    // Both the original kick and the re-kick now run. Each one advances the
    // delivery by the next page, so the cohort is covered once, not twice.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expectDeliveredOnce(await notificationCounts(t), "Lost kick", org);
    expect(await deliveryRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toEqual(IDLE);
  });

  test("a kick for a delivery that already finished is a no-op", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 4 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Done" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    const [row] = await deliveryRows(t);
    await driveDeliveries(t);
    const before = await notificationCounts(t);
    const completed = await t.run((ctx) => ctx.db.get(row._id));
    expect(completed).toMatchObject({ status: "COMPLETED", taskTitle: "Done", completedAt: NOW });

    await expect(
      t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id })
    ).resolves.toBeNull();

    const after = await notificationCounts(t);
    expect(after.total).toBe(before.total);
    expectDeliveredOnce(after, "Done", org);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toEqual(completed);
  });

  test("a purge that starts mid-delivery stops it: no further notifications or sends, and cancellation history remains", async () => {
    const t = limited();
    // 200 managers with every channel on: pages of 199 and 1, so the purge can
    // arrive between them with real sends at stake.
    const org = await seedOrg(t, { managers: PAGE + 1, allChannels: true });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Purged" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    const [row] = await deliveryRows(t);
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id });
    expect((await notificationCounts(t)).warnings.get("Purged")).toBe(PAGE);
    const notificationsBefore = (await notificationCounts(t)).total;
    const scheduledBefore = await scheduledTotal(t);

    // hardDeleteOrg stamps this before its first destructive step; the kick for the
    // next page was already scheduled and now runs.
    await t.run((ctx) => ctx.db.patch(org.orgId, { suspended: true, destructivePurgeStartedAt: NOW }));
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id });

    expect((await notificationCounts(t)).total).toBe(notificationsBefore);
    expect(await scheduledTotal(t)).toBe(scheduledBefore);
    expect(await deliveryRows(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "CANCELLED", completedAt: NOW });
  });

  test("a purge that has not started does not stop a suspended organization's delivery", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: PAGE + 1 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Suspended" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    // Suspension can end, and the pre-delivery code warned regardless of it.
    await t.run((ctx) => ctx.db.patch(org.orgId, { suspended: true }));

    await driveDeliveries(t);

    expectDeliveredOnce(await notificationCounts(t), "Suspended", org);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test("a delivery whose organization no longer exists sends nothing and leaves active work", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 3 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Orphaned" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    const before = (await notificationCounts(t)).total;
    await t.run((ctx) => ctx.db.delete(org.orgId));

    await driveDeliveries(t);

    expect((await notificationCounts(t)).total).toBe(before);
    expect(await deliveryRows(t)).toHaveLength(0);
  });

  test.each(["COMPLETED", "CANCELLED", "deleted"] as const)(
    "a task that is %s mid-delivery stops the remaining pages",
    async (ending) => {
      const t = limited();
      const org = await seedOrg(t, { managers: PAGE + 51 });
      const [taskId] = await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Ended" }]);
      await t.mutation(internal.crons.triggerAlarms, {});
      const [row] = await deliveryRows(t);
      await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id });
      expect((await notificationCounts(t)).warnings.get("Ended")).toBe(PAGE);

      await t.run((ctx) =>
        ending === "deleted" ? ctx.db.delete(taskId) : ctx.db.patch(taskId, { status: ending })
      );
      await driveDeliveries(t);

      // The first page was owed when it ran; nothing after the task ended.
      expect((await notificationCounts(t)).warnings.get("Ended")).toBe(PAGE);
      expect(await deliveryRows(t)).toHaveLength(0);
      const cancelled = await t.run((ctx) => ctx.db.get(row._id));
      expect(cancelled).toMatchObject({ status: "CANCELLED", completedAt: NOW });
      const beforeReplay = await notificationCounts(t);
      const scheduledBeforeReplay = await scheduledTotal(t);
      await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id });
      expect(await t.run((ctx) => ctx.db.get(row._id))).toEqual(cancelled);
      expect(await notificationCounts(t)).toEqual(beforeReplay);
      expect(await scheduledTotal(t)).toBe(scheduledBeforeReplay);
    }
  );

  test("a task that ended before the first page gets no manager warning at all", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 4 });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Done early" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    await t.run((ctx) => ctx.db.patch(taskId, { status: "COMPLETED" }));

    await driveDeliveries(t);

    const counts = await notificationCounts(t);
    expect(counts.warnings.get("Done early")).toBeUndefined();
    // The assignee's alert was sent by the alarm itself and is not retracted.
    expect(counts.dueSoon.get(taskId)).toBe(1);
  });

  test("a page that fails is rolled back whole, retried a bounded number of times, then parked as FAILED with a failed heartbeat", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 5 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Poison" }]);
    // The third manager's dispatch throws, after the first two were dispatched.
    await poisonManager(t, org, 2);
    await t.mutation(internal.crons.triggerAlarms, {});
    const [row] = await deliveryRows(t);
    const before = await notificationCounts(t);

    await expect(
      t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id })
    ).rejects.toThrow();

    // No partial page: nothing from the managers dispatched before the failure,
    // and the row still says "not started".
    expect((await notificationCounts(t)).total).toBe(before.total);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({
      cursor: null,
      status: "ACTIVE",
      attempts: 0,
    });

    // A rolled-back page cannot count its own failure, so the sweep counts re-kicks.
    for (let rekick = 1; rekick <= MAX_REKICKS; rekick++) {
      vi.setSystemTime(NOW + rekick * (STALLED_MS + MINUTE_MS));
      expect(await t.mutation(internal.crons.triggerAlarms, {})).toMatch(/Re-queued 1 stalled/);
      expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "ACTIVE", attempts: rekick });
    }
    const kicksBeforeGivingUp = (await pendingScheduled(t)).deliveries;

    vi.setSystemTime(NOW + (MAX_REKICKS + 1) * (STALLED_MS + MINUTE_MS));
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toMatch(/Gave up on 1 manager delivery/);

    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "FAILED", attempts: MAX_REKICKS });
    expect((await pendingScheduled(t)).deliveries).toBe(kicksBeforeGivingUp);
    const heartbeats = await alarmHeartbeats(t);
    expect(heartbeats.at(-1)).toEqual({
      success: false,
      detail: expect.stringMatching(/Gave up on 1 manager delivery/),
    });

    // Parked: later ticks neither re-kick nor re-report it, and a stray kick is a no-op.
    vi.setSystemTime(NOW + (MAX_REKICKS + 3) * (STALLED_MS + MINUTE_MS));
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toBe("Triggered alarms for 0 tasks.");
    expect((await alarmHeartbeats(t)).at(-1)?.success).toBe(true);
    await expect(
      t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id })
    ).resolves.toBeNull();
    expect((await notificationCounts(t)).total).toBe(before.total);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "FAILED" });
  });

  test.each(["FAILED", "COMPLETED", "CANCELLED"] as const)("retained %s deliveries do not use up the sweep's slots: a stalled live delivery is still re-queued", async (status) => {
    const t = limited();
    const org = await seedOrg(t, { managers: 4 });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW + WINDOW_MS * 4, title: "Live" }]);
    await t.run(async (ctx) => {
      // More parked rows than one sweep reads, all older than the live one.
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("taskAlarmDeliveries", {
          orgId: org.orgId,
          taskId,
          taskTitle: "Parked",
          assigneeName: "Assignee",
          cursor: null,
          lastProgressAt: 1 + i,
          status,
          attempts: MAX_REKICKS,
        });
      }
      await ctx.db.insert("taskAlarmDeliveries", {
        orgId: org.orgId,
        taskId,
        taskTitle: "Live",
        assigneeName: "Assignee",
        cursor: null,
        lastProgressAt: NOW - STALLED_MS - MINUTE_MS,
        status: "ACTIVE",
        attempts: 0,
      });
    });

    expect(await t.mutation(internal.crons.triggerAlarms, {})).toMatch(/Re-queued 1 stalled/);
    expect((await pendingScheduled(t)).deliveries).toBe(1);
  });

  test("a re-kicked delivery that then makes progress is not charged against the retry cap", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: PAGE + 51 });
    await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Recovered" }]);
    await t.mutation(internal.crons.triggerAlarms, {});
    const [row] = await deliveryRows(t);
    vi.setSystemTime(NOW + STALLED_MS + MINUTE_MS);
    expect(await t.mutation(internal.crons.triggerAlarms, {})).toMatch(/Re-queued 1 stalled/);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ attempts: 1 });

    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: row._id });

    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({
      status: "ACTIVE",
      attempts: 0,
      cursor: expect.any(String),
    });
  });

  test("a full hop of tasks whose assignees have every channel on stays inside the scheduled-function ceiling", async () => {
    const t = limited();
    const org = await seedOrg(t, { managers: 2, assigneeAllChannels: true });
    // Both buckets full: each read returns BATCH tasks, so without the hop cap
    // this transaction would alarm 2 x BATCH and schedule 1,548 functions.
    const ids = await seedTasks(
      t,
      org,
      Array.from({ length: BATCH * 2 }, (_, i) => ({
        dueDate: NOW - 60_000 + i,
        alarm: i % 2 === 0 ? ("unset" as const) : ("false" as const),
      }))
    );

    await t.mutation(internal.crons.triggerAlarms, {});

    expect(await flaggedAmong(t, ids)).toHaveLength(BATCH);
    // Per task: 4 assignee channel sends + the task email, then 1 delivery kick;
    // plus the hop's own continuation. Fan-out to managers is not in this hop.
    const pending = await pendingScheduled(t);
    expect(pending).toEqual({ continuations: 1, deliveries: BATCH, other: BATCH * 5 });
    expect(await scheduledTotal(t)).toBeLessThanOrEqual(BUDGET);
  });
});

// The deletion order is frozen (SCRUM-563), so the delivery's own guard is what
// protects a purge in flight. The reserved final step must preserve delivery
// history, including a parked FAILED row that no kick will visit again.
describe("task alarm delivery against a real organization purge", () => {
  const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

  beforeEach(() => {
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
    process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  });

  afterEach(() => {
    process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  test("a page that runs once the purge has begun sends nothing, and the purge retains delivery history", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const org = await seedOrg(t, { managers: 3 });
    const [taskId] = await seedTasks(t, org, [{ dueDate: NOW - 1_000, title: "Mid purge" }]);
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
    await t.mutation(internal.crons.triggerAlarms, {});
    const [live] = await deliveryRows(t);
    // A parked FAILED delivery, which no kick will ever visit again.
    const parked = await t.run((ctx) =>
      ctx.db.insert("taskAlarmDeliveries", {
        orgId: org.orgId,
        taskId,
        taskTitle: "Parked",
        assigneeName: "someone@example.com",
        cursor: null,
        lastProgressAt: 1,
        status: "FAILED",
        attempts: MAX_REKICKS,
      })
    );

    const orgName = (await t.run((ctx) => ctx.db.get(org.orgId)))?.name ?? "";
    const request = await t.withIdentity({ subject: "dev_admin" }).mutation(api.adminOrgs.hardDeleteOrg, {
      orgId: org.orgId,
      confirmName: orgName,
    });
    await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request.requestId });

    // The window: the purge has stamped its marker, but the task is still there, so
    // only the lifecycle guard can stop a page.
    expect((await t.run((ctx) => ctx.db.get(org.orgId)))?.destructivePurgeStartedAt).toBeDefined();
    expect(await t.run((ctx) => ctx.db.get(taskId))).not.toBeNull();
    const before = await notificationCounts(t);
    await t.mutation(internal.crons.deliverTaskAlarmToManagers, { deliveryId: live._id });
    expect((await notificationCounts(t)).total).toBe(before.total);
    expect((await notificationCounts(t)).warnings.get("Mid purge")).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(live._id))).toMatchObject({ status: "CANCELLED" });

    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await t.run((ctx) => ctx.db.get(request.requestId));
      if (current?.status !== "RUNNING") break;
      await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request.requestId });
    }

    expect((await t.run((ctx) => ctx.db.get(request.requestId)))?.status).toBe("COMPLETED");
    expect(await t.run((ctx) => ctx.db.get(parked))).toMatchObject({ status: "FAILED" });
    expect(await t.run((ctx) => ctx.db.get(live._id))).toMatchObject({ status: "CANCELLED" });
  });
});
