import { getAuthorName } from "../lib/authorName";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, mutation, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { canReceiveComment, canReceiveMention, mentionEmail } from "../lib/commentNotifications";

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
      if (!task || !message || !(await canReceiveComment(ctx, userId, task, message, row.kind))) continue;
      const current = groups.get(String(task._id));
      const author = await getAuthorName(ctx, message.userId, message.source === "trello" ? "Trello" : message.source === "cor" ? "COR" : "Autor sin nombre");
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
      if (!message) continue;
      const row = await ctx.db.query("commentNotifications").withIndex("by_user_message", q => q.eq("userId", userId).eq("messageId", messageId)).unique();
      if (row && !row.read && await canReceiveComment(ctx, userId, task, message, row.kind)) await ctx.db.patch(row._id, { read: true });
    }
  },
});

export const claimEmail = internalMutation({
  args: { id: v.id("commentNotifications") }, handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    const now = Date.now();
    if (!row || row.kind !== "mention" || !["pending", "sending"].includes(row.emailState ?? "") || (row.nextAttemptAt ?? 0) > now) return null;
    const task = await ctx.db.get(row.taskId);
    const message = await ctx.db.get(row.messageId);
    if (!task || !message || !(await canReceiveMention(ctx, row.userId, task, message))) {
      await ctx.db.patch(id, { emailState: "cancelled", emailError: "El destinatario ya no tiene acceso a la tarea." }); return null;
    }
    if ((row.attempts ?? 0) >= 8 || (row.firstAttemptAt !== undefined && now - row.firstAttemptAt >= 23 * 60 * 60 * 1000)) {
      await ctx.db.patch(id, { emailState: "failed", emailError: "Se agotaron los reintentos seguros. Revisar el envío en Resend antes de reenviar." }); return null;
    }
    const user = await ctx.db.get(row.userId);
    const email = user?.email?.trim();
    if (!email) { await ctx.db.patch(id, { emailState: "failed", emailError: "Usuario sin correo configurado." }); return null; }
    let payload = row.emailPayload;
    try {
      if (!process.env.RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY en Convex.");
      if (!payload) {
        const baseUrl = process.env.APP_URL || process.env.SITE_URL;
        if (!baseUrl) throw new Error("Falta APP_URL o SITE_URL en Convex.");
        const external = Boolean(await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", row.userId)).unique());
        payload = JSON.stringify(mentionEmail({ from: process.env.RESEND_FROM_EMAIL || "Punto99 <digital@pto99.com>", to: email, baseUrl, taskId: task._id, title: task.title, author: await getAuthorName(ctx, message.userId), comment: message.message, quote: message.userQuote, external }));
      } else if (JSON.parse(payload).to[0] !== email) {
        await ctx.db.patch(id, { emailState: "cancelled", emailError: "El correo del destinatario cambió durante el envío." }); return null;
      }
    } catch (error) {
      await ctx.db.patch(id, { emailState: "pending", nextAttemptAt: now + 300000, emailError: error instanceof Error ? error.message : "Configuración de correo inválida." }); return null;
    }
    const attempt = (row.attempts ?? 0) + 1;
    await ctx.db.patch(id, { emailState: "sending", attempts: attempt, firstAttemptAt: row.firstAttemptAt ?? now, nextAttemptAt: now + 120000, emailPayload: payload, emailError: undefined });
    return { payload, attempt, key: `comment-mention/${id}` };
  },
});

export const finishEmail = internalMutation({
  args: { id: v.id("commentNotifications"), attempt: v.number(), resendId: v.optional(v.string()), error: v.optional(v.string()), retry: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.emailState !== "sending" || row.attempts !== args.attempt) return;
    await ctx.db.patch(row._id, args.resendId ? { emailState: "sent", resendId: args.resendId, emailSentAt: Date.now(), emailError: undefined } : { emailState: args.retry && (row.attempts ?? 0) < 8 ? "pending" : "failed", emailError: args.error || "No se pudo confirmar el envío.", nextAttemptAt: Date.now() + Math.min(3600000, 60000 * 2 ** (row.attempts ?? 0)) });
  },
});

export const sendEmail = internalAction({
  args: { id: v.id("commentNotifications") }, handler: async (ctx, { id }): Promise<void> => {
    const claim = await ctx.runMutation(internal.data.commentNotifications.claimEmail, { id });
    if (!claim) return;
    let resendId: string | undefined;
    let error: string | undefined;
    let retry = false;
    try {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": claim.key }, body: claim.payload, signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (response.ok && typeof data.id === "string") resendId = data.id;
      else { error = `Resend ${response.status}: ${typeof data.name === "string" ? data.name : "respuesta sin confirmación"}`; retry = response.status >= 500 || response.status === 429 || data.name === "concurrent_idempotent_requests" || response.ok; }
    } catch { error = "No se pudo confirmar la respuesta de Resend."; retry = true; }
    await ctx.runMutation(internal.data.commentNotifications.finishEmail, { id, attempt: claim.attempt, resendId, error, retry });
  },
});

export const sweep = internalMutation({
  args: {}, handler: async ctx => {
    for (const state of ["pending", "sending"] as const) {
      const rows = await ctx.db.query("commentNotifications").withIndex("by_email_due", q => q.eq("emailState", state).lte("nextAttemptAt", Date.now())).take(25);
      for (const [index, row] of rows.entries()) await ctx.scheduler.runAfter(index * 1000, internal.data.commentNotifications.sendEmail, { id: row._id });
    }
  },
});
