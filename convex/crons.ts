import { cronJobs } from "convex/server";
import { internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { notifyManagers, notifyUser } from "./utils/notifications";

const crons = cronJobs();

// Run every 5 minutes to check for upcoming tasks
crons.interval(
  "check-upcoming-tasks",
  { minutes: 5 }, // Every 5 minutes
  internal.crons.triggerAlarms
);

export default crons;

export const triggerAlarms = internalMutation({
  args: {},
  handler: async (ctx) => {
    try {
      const result = await runTriggerAlarms(ctx);
      await ctx.db.insert("cronHeartbeats", { jobName: "check-upcoming-tasks", ranAt: Date.now(), success: true, detail: result });
      return result;
    } catch (err) {
      await ctx.db.insert("cronHeartbeats", {
        jobName: "check-upcoming-tasks",
        ranAt: Date.now(),
        success: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

async function runTriggerAlarms(ctx: MutationCtx) {
  const now = Date.now();
  // Look for tasks due in the next 15 minutes (or overdue) that haven't been triggered
  const upcomingThreshold = now + 15 * 60 * 1000;

  const allPendingTasks = await ctx.db
    .query("tasks")
    .withIndex("by_status_alarm", (q) => q.eq("status", "PENDING"))
    .filter((q) => q.neq(q.field("alarmTriggered"), true))
    .collect();

  let triggeredCount = 0;

  for (const task of allPendingTasks) {
    if (task.dueDate <= upcomingThreshold) {
      // Mark as triggered
      await ctx.db.patch(task._id, { alarmTriggered: true });

      // Create in-app notification for the assignee
      await notifyUser(
        ctx,
        task.orgId,
        task.assignedTo,
        "task.due_soon",
        { taskTitle: task.title, dueTime: new Date(task.dueDate).toLocaleTimeString() },
        { link: `/${task.orgId}/tasks`, relatedTaskId: task._id }
      );

      // Fetch assignee details for notifications and email
      const assignee = await ctx.db.get(task.assignedTo);
      const assigneeName = assignee ? (assignee.name || assignee.email) : 'someone';
      const email = assignee?.email;

      // Notify managers about the upcoming/overdue task
      await notifyManagers(
        ctx,
        task.orgId,
        "task.overdue_warning",
        { taskTitle: task.title, assigneeName },
        { link: "/tasks" }
      );

      if (email) {
        await ctx.scheduler.runAfter(0, internal.email.sendTaskAlarm, {
          toEmail: email,
          taskTitle: task.title,
          taskDescription: task.description,
          dueDate: task.dueDate,
        });
      }

      triggeredCount++;
    }
  }

  return `Triggered alarms for ${triggeredCount} tasks.`;
}
