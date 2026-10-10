import { canViewExternalRequest, isRequestsClientTask } from "./externalRequestsAccess";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hasTaskAccess } from "../data/tasks";
import { eligibleMentionUsers, mentionsForSync } from "./taskMentions";
import { formatPanelCommentForCOR } from "./taskPanelComment";

// Escape user content and keep attachments as links, without loading remote images.
export function mentionEmail(args: { from: string; to: string; baseUrl: string; taskId: string; title: string; author: string; comment: string; quote?: string; external: boolean }) {
  const base = new URL(args.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password) throw new Error("APP_URL/SITE_URL debe usar HTTPS, o HTTP en localhost para pruebas locales.");
  const url = new URL(args.external ? "/workspace/requests" : "/workspace/control-panel", base);
  url.searchParams.set("taskId", args.taskId); url.searchParams.set("tab", "comments");
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const comment = mentionsForSync(args.comment);
  const intro = `${args.author} te mencionó en un comentario.`;
  return {
    from: args.from, to: [args.to],
    subject: `Te mencionaron en: ${args.title}`.replace(/[\r\n]/g, " ").slice(0, 200),
    text: [intro, `Tarea: ${args.title}`, "", comment, args.quote ? `Cita: ${args.quote}` : "", "", `Ver tarea: ${url.href}`].join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#172b4d;line-height:1.6"><h2>Te mencionaron en un comentario</h2><p>${escape(intro)}</p><p><strong>${escape(args.title)}</strong></p><div style="padding:16px;background:#f4f5f7;border-radius:8px">${formatPanelCommentForCOR(comment)}${args.quote ? `<blockquote>${escape(args.quote)}</blockquote>` : ""}</div><p><a style="display:inline-block;padding:10px 18px;background:#0c66e4;color:#fff;border-radius:6px;text-decoration:none" href="${escape(url.href)}">Ver tarea</a></p></div>`,
  };
}

export async function canReceiveMention(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">, message: Doc<"taskMessages">) {
  if (task.convexStatus === "deleted" || task.convexStatus === "archived" || message.taskId !== task._id ||
      message.userId === userId || !message.mentionedUserIds?.includes(userId)) return false;
  if (!(await isRequestsClientTask(ctx, task)) || !(await eligibleMentionUsers(ctx, task)).some(person => person.id === userId)) return false;
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (!external) return await hasTaskAccess(ctx, task, userId);
  if (!["external_panel", "internal_panel", "external_agent", "trello"].includes(message.source)) return false;
  if (message.replyTo) {
    const parent = await ctx.db.get(message.replyTo);
    if (!parent || parent.taskId !== task._id || !["external_panel", "internal_panel", "external_agent", "trello"].includes(parent.source)) return false;
  }
  return await canViewExternalRequest(ctx, userId, task);
}

export async function canReceiveComment(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">, message: Doc<"taskMessages">, kind?: "mention") {
  if (kind === "mention") return await canReceiveMention(ctx, userId, task, message);
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
  message.mentionedUserIds?.forEach(id => recipients.add(id));
  for (const userId of recipients) {
    const mention = await canReceiveMention(ctx, userId, task, message);
    if (!mention && !(await canReceiveComment(ctx, userId, task, message))) continue;
    const existing = await ctx.db.query("commentNotifications").withIndex("by_user_message", q => q.eq("userId", userId).eq("messageId", messageId)).unique();
    if (!existing) await ctx.db.insert("commentNotifications", { userId, taskId: task._id, messageId, read: false, createdAt: Date.now(), ...(mention ? { kind: "mention" as const, emailState: "pending" as const, attempts: 0, nextAttemptAt: Date.now() } : {}) });
  }
}
