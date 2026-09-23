import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { canReceiveComment } from "../lib/commentNotifications";

export const unread = query({
  args: {},
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("commentNotifications").withIndex("by_user_read", q => q.eq("userId", userId).eq("read", false)).collect();
    const groups = new Map<string, { taskId: typeof rows[number]["taskId"]; title: string; count: number; createdAt: number; author: string; external: boolean; messageIds: typeof rows[number]["messageId"][] }>();
    const external = Boolean(await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique());
    for (const row of rows) {
      const task = await ctx.db.get(row.taskId);
      const message = await ctx.db.get(row.messageId);
      if (!task || !message || !(await canReceiveComment(ctx, userId, task, message))) continue;
      const current = groups.get(String(task._id));
      const author = message.userId ? (await ctx.db.get(message.userId))?.name || "Alguien" : message.source === "trello" ? "Trello" : message.source === "cor" ? "COR" : "Alguien";
      groups.set(String(task._id), { taskId: task._id, title: task.title, count: (current?.count ?? 0) + 1, createdAt: Math.max(current?.createdAt ?? 0, row.createdAt), author: current && current.createdAt > row.createdAt ? current.author : author, messageIds: [...(current?.messageIds ?? []), row.messageId], external });
    }
    return [...groups.values()].sort((a,b) => b.createdAt - a.createdAt);
  },
});

export const markRead = mutation({
  args: { taskId: v.id("tasks"), messageIds: v.array(v.id("taskMessages")) },
  handler: async (ctx, { taskId, messageIds }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    if (messageIds.length > 100) throw new Error("Demasiados comentarios");
    const task = await ctx.db.get(taskId);
    if (!task) return;
    // Acknowledge only messages actually rendered, never a timestamp supplied by the client.
    for (const messageId of new Set(messageIds)) {
      const message = await ctx.db.get(messageId);
      if (!message || !(await canReceiveComment(ctx, userId, task, message))) continue;
      const row = await ctx.db.query("commentNotifications").withIndex("by_user_message", q => q.eq("userId", userId).eq("messageId", messageId)).unique();
      if (row && !row.read) await ctx.db.patch(row._id, { read: true });
    }
  },
});
