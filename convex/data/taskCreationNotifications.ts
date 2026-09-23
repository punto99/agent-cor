import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, mutation, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { canReceiveTaskCreation, taskCreationEmail } from "../lib/taskCreationNotifications";

export const unread = query({
  args: {}, handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("taskCreationNotifications").withIndex("by_user_read", q => q.eq("userId", userId).eq("read", false)).collect();
    const result = [];
    for (const row of rows) {
      const task = await ctx.db.get(row.taskId);
      if (!task || !(await canReceiveTaskCreation(ctx, userId, task))) continue;
      const creator = task.createdBy ? ctx.db.normalizeId("users", task.createdBy) : null;
      result.push({ taskId: task._id, title: task.title, author: creator ? (await ctx.db.get(creator))?.name || "Un usuario externo" : "Un usuario externo", client: task.corClientName || "", brand: task.subBrandName || "", createdAt: row.createdAt });
    }
    return result.sort((a,b) => b.createdAt - a.createdAt);
  },
});

export const markRead = mutation({
  args: { taskId: v.id("tasks") }, handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    const task = await ctx.db.get(taskId);
    if (!userId || !task || !(await canReceiveTaskCreation(ctx, userId, task))) return;
    const row = await ctx.db.query("taskCreationNotifications").withIndex("by_user_task", q => q.eq("userId", userId).eq("taskId", taskId)).unique();
    if (row && !row.read) await ctx.db.patch(row._id, { read: true });
  },
});

export const claimEmail = internalMutation({
  args: { id: v.id("taskCreationNotifications") }, handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    const now = Date.now();
    if (!row || !["pending", "sending"].includes(row.emailState) || row.nextAttemptAt > now) return null;
    const task = await ctx.db.get(row.taskId);
    if (!task || !(await canReceiveTaskCreation(ctx, row.userId, task))) {
      await ctx.db.patch(id, { emailState: "cancelled", emailError: "El destinatario ya no tiene acceso a la tarea." }); return null;
    }
    if (row.attempts >= 8 || (row.firstAttemptAt !== undefined && now - row.firstAttemptAt >= 23 * 60 * 60 * 1000)) {
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
        const creator = task.createdBy ? ctx.db.normalizeId("users", task.createdBy) : null;
        const client = task.clientId ? await ctx.db.get(task.clientId) : null;
        payload = JSON.stringify(taskCreationEmail({ from: process.env.RESEND_FROM_EMAIL || "Punto99 <digital@pto99.com>", to: email, baseUrl, taskId: task._id, title: task.title, author: creator ? (await ctx.db.get(creator))?.name || "Un usuario externo" : "Un usuario externo", client: client?.name || task.corClientName || "Cliente", category: task.brandName, brand: task.subBrandName, deadline: task.deadline }));
      } else if (JSON.parse(payload).to[0] !== email) {
        await ctx.db.patch(id, { emailState: "cancelled", emailError: "El correo del destinatario cambió durante el envío." }); return null;
      }
    } catch (error) {
      await ctx.db.patch(id, { emailState: "pending", nextAttemptAt: now + 300000, emailError: error instanceof Error ? error.message : "Configuración de correo inválida." }); return null;
    }
    const attempt = row.attempts + 1;
    await ctx.db.patch(id, { emailState: "sending", attempts: attempt, firstAttemptAt: row.firstAttemptAt ?? now, nextAttemptAt: now + 120000, emailPayload: payload, emailError: undefined });
    return { payload, attempt, key: `new-external-task/${id}` };
  },
});

export const finishEmail = internalMutation({
  args: { id: v.id("taskCreationNotifications"), attempt: v.number(), resendId: v.optional(v.string()), error: v.optional(v.string()), retry: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.emailState !== "sending" || row.attempts !== args.attempt) return;
    await ctx.db.patch(row._id, args.resendId ? { emailState: "sent", resendId: args.resendId, emailSentAt: Date.now(), emailError: undefined } : { emailState: args.retry && row.attempts < 8 ? "pending" : "failed", emailError: args.error || "No se pudo confirmar el envío.", nextAttemptAt: Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts) });
  },
});

export const sendEmail = internalAction({
  args: { id: v.id("taskCreationNotifications") }, handler: async (ctx, { id }): Promise<void> => {
    const claim = await ctx.runMutation(internal.data.taskCreationNotifications.claimEmail, { id });
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
    await ctx.runMutation(internal.data.taskCreationNotifications.finishEmail, { id, attempt: claim.attempt, resendId, error, retry });
  },
});

export const sweep = internalMutation({
  args: {}, handler: async ctx => {
    for (const state of ["pending", "sending"] as const) {
      const rows = await ctx.db.query("taskCreationNotifications").withIndex("by_email_due", q => q.eq("emailState", state).lte("nextAttemptAt", Date.now())).take(25);
      for (const [index, row] of rows.entries()) await ctx.scheduler.runAfter(index * 1000, internal.data.taskCreationNotifications.sendEmail, { id: row._id });
    }
  },
});
