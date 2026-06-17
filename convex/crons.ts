import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { notifyManagers } from "./utils/notifications";

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

        // Create in-app notification
        await ctx.db.insert("notifications", {
          orgId: task.orgId,
          userId: task.assignedTo,
          title: "Upcoming Task",
          message: `Your task "${task.title}" is scheduled for ${new Date(task.dueDate).toLocaleTimeString()}`,
          isRead: false,
          link: `/${task.orgId}/tasks`,
          relatedTaskId: task._id,
        });

        // Fetch assignee details for notifications and email
        const assignee = await ctx.db.get(task.assignedTo);
        const assigneeName = assignee ? (assignee.name || assignee.email) : 'someone';
        const email = assignee?.email;

        // Notify managers about the upcoming/overdue task
        await notifyManagers(
          ctx,
          task.orgId,
          "Task Overdue Warning",
          `Task "${task.title}" assigned to ${assigneeName} is due soon or overdue!`,
          "/tasks"
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
  },
});
