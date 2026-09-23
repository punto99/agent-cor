import { canViewExternalRequest, isRequestsClientTask } from "./externalRequestsAccess";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hasTaskAccess } from "../data/tasks";

export async function canReceiveComment(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">, message: Doc<"taskMessages">) {
  if (task.convexStatus === "deleted" || message.taskId !== task._id || message.userId === userId) return false;
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return await isRequestsClientTask(ctx, task) && await hasTaskAccess(ctx, task, userId);
  if (task.source !== "external" || task.createdBy !== String(userId) || message.source !== "internal_panel" || !message.userId) return false;
  if (!(await canViewExternalRequest(ctx, userId, task))) return false;
  // Only authenticated internal authors can notify an external task creator.
  return !(await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", message.userId!)).unique());
}

export async function notifyTaskComment(ctx: MutationCtx, messageId: Id<"taskMessages">) {
  const message = await ctx.db.get(messageId);
  if (!message) return;
  const task = await ctx.db.get(message.taskId);
  if (!task || task.convexStatus === "deleted") return;
  let clientId = task.clientId;
  if (task.clientBrandId) clientId = (await ctx.db.get(task.clientBrandId))?.clientId;
  if (!clientId && task.corClientId) clientId = (await ctx.db.query("corClients").withIndex("by_corClientId", q => q.eq("corClientId", task.corClientId!)).unique())?._id;
  const recipients = new Set<Id<"users">>();
  if (clientId) {
    const assignments = await ctx.db.query("clientUserAssignments").withIndex("by_client", q => q.eq("clientId", clientId!)).collect();
    assignments.forEach(a => recipients.add(a.userId));
  }
  if (task.createdBy) {
    const creator = ctx.db.normalizeId("users", task.createdBy);
    if (creator) recipients.add(creator);
  }
  for (const userId of recipients) {
    if (!(await canReceiveComment(ctx, userId, task, message))) continue;
    const existing = await ctx.db.query("commentNotifications").withIndex("by_user_message", q => q.eq("userId", userId).eq("messageId", messageId)).unique();
    if (!existing) await ctx.db.insert("commentNotifications", { userId, taskId: task._id, messageId, read: false, createdAt: Date.now() });
  }
}
