import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import schema from "../schema";
import { canReceiveComment } from "../lib/commentNotifications";
import { canReceiveTaskCreation } from "../lib/taskCreationNotifications";

// Merge indexed streams before pagination, including existing read records.
// Authorization runs before returning each item, even on subsequent pages.
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    const external = Boolean(await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique());
    const db = stream(ctx.db, schema);
    return await mergedStream<Doc<"commentNotifications"> | Doc<"taskCreationNotifications">>([
      db.query("commentNotifications").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc"),
      db.query("taskCreationNotifications").withIndex("by_user_created", q => q.eq("userId", userId)).order("desc"),
    ], ["createdAt", "_creationTime", "_id"])
      .map(async row => {
        const task = await ctx.db.get(row.taskId);
        if (!task) return null;
        if ("messageId" in row) {
          const message = await ctx.db.get(row.messageId);
          if (!message || !(await canReceiveComment(ctx, userId, task, message))) return null;
          const author = message.userId ? (await ctx.db.get(message.userId))?.name || "Alguien" : message.source === "trello" ? "Trello" : message.source === "cor" ? "COR" : "Alguien";
          return { id: row._id, taskId: task._id, title: task.title, kind: "comment" as const, author, external, read: row.read, createdAt: row.createdAt, context: "" };
        }
        if (!(await canReceiveTaskCreation(ctx, userId, task))) return null;
        const creator = task.createdBy ? ctx.db.normalizeId("users", task.createdBy) : null;
        return { id: row._id, taskId: task._id, title: task.title, kind: "task" as const, author: creator ? (await ctx.db.get(creator))?.name || "Un usuario externo" : "Un usuario externo", external: false, read: row.read, createdAt: row.createdAt, context: [task.corClientName, task.subBrandName].filter(Boolean).join(" · ") };
      })
      .paginate({ ...paginationOpts, numItems: Math.min(50, Math.max(1, paginationOpts.numItems)), maximumRowsRead: 200 });
  },
});
