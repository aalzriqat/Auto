import { cronJobs } from "convex/server";
import { mutation } from "./_generated/server";
import { api } from "./_generated/api";

const crons = cronJobs();

// Run every 5 minutes to check for upcoming tasks
crons.interval(
  "check-upcoming-tasks",
  { minutes: 5 }, // Every 5 minutes
  api.crons.triggerAlarms
);

export default crons;

export const triggerAlarms = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Look for tasks due in the next 15 minutes (or overdue) that haven't been triggered
    const upcomingThreshold = now + 15 * 60 * 1000;

    const pendingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_org_status", (q) => q.eq("orgId", "" as any)) // Cannot easily query across all orgs using index if we don't have orgId
      .collect();

    // Workaround since we need to scan all tasks across all orgs
    // A better approach in a real multi-tenant app is to have an index by status or dueDate
    // Let's just do a full table scan for tasks since they are generally small, or we can index by status.
    const allPendingTasks = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("status"), "PENDING"))
      .filter((q) => q.neq(q.field("alarmTriggered"), true))
      .collect();

    let triggeredCount = 0;

    for (const task of allPendingTasks) {
      if (task.dueDate <= upcomingThreshold) {
        // Mark as triggered
        await ctx.db.patch(task._id, { alarmTriggered: true });

        // Create in-app notification
        await ctx.db.insert("notifications", {
          orgId: task.orgId,
          userId: task.assignedTo,
          title: "Upcoming Task",
          message: `Your task "${task.title}" is scheduled for ${new Date(task.dueDate).toLocaleTimeString()}`,
          isRead: false,
          link: "/tasks",
          relatedTaskId: task._id,
        });

        // Schedule email action
        const assignee = await ctx.db.get(task.assignedTo);
        const email = assignee?.email;

        if (email) {
          await ctx.scheduler.runAfter(0, api.email.sendTaskAlarm, {
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
  },
});
