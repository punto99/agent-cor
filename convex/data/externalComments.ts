import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { usesDirectExternalComments } from "../lib/directExternalComments";
import { getProjectManagementProvider } from "../integrations/registry";
import { formatTrelloCommentForCOR } from "../lib/trelloCommentFormat";
import type { ProjectManagementProvider } from "../integrations/types";

const refs = () => (internal as any).data.externalComments;
const validCorId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

// Recheck ownership and full client access inside the saving transaction.
async function requireTask(ctx: any, threadId: string, taskId?: string) {
  const thread = await ctx.db.query("chatThreads")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId)).unique();
  if (!thread) throw new Error("No se encontró la conversación.");
  const approved = await ctx.db.query("approvedExternalUsers")
    .withIndex("by_user", (q: any) => q.eq("userId", thread.userId)).unique();
  const id = taskId ? ctx.db.normalizeId("tasks", taskId) : undefined;
  const task = taskId ? (id ? await ctx.db.get(id) : null) : await ctx.db.query("tasks")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId)).first();
  if (!approved || !task || task.convexStatus === "deleted" ||
      String(task.createdBy) !== String(thread.userId) || !usesDirectExternalComments(task)) {
    throw new Error("No tienes acceso a este requerimiento sin Trello.");
  }
  if (task.threadId !== threadId) {
    throw new Error("Para agregar comentarios o archivos, abre la conversación donde creaste este requerimiento.");
  }
  if (!task.clientId) throw new Error("El requerimiento no tiene cliente validado.");
  const assignments = await ctx.db.query("clientUserAssignments")
    .withIndex("by_client_and_user", (q: any) => q.eq("clientId", task.clientId).eq("userId", thread.userId)).collect();
  if (!assignments.some((a: any) => a.brandId === undefined)) {
    throw new Error("Ya no tienes acceso a este cliente.");
  }
  return { task, userId: thread.userId };
}

export const save = internalMutation({
  args: { threadId: v.string(), taskId: v.optional(v.string()), requestMessageId: v.string(), comment: v.optional(v.string()), includePendingFiles: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { task, userId } = await requireTask(ctx, args.threadId, args.taskId);
    const [request] = await ctx.runQuery(components.agent.messages.getMessagesByIds, { messageIds: [args.requestMessageId] });
    if (!request || request.threadId !== args.threadId || request.message?.role !== "user" || request._creationTime < task._creationTime) {
      throw new Error("El pedido no pertenece a esta conversación.");
    }
    const existing = await ctx.db.query("taskMessages").withIndex("by_request", q =>
      q.eq("requestThreadId", args.threadId).eq("requestMessageId", args.requestMessageId)).unique();
    if (existing) {
      if (existing.taskId !== task._id) throw new Error("Este pedido ya pertenece a otra tarea.");
      return { id: existing._id, status: existing.corMessageSyncStatus };
    }
    // Current-message files are automatic. Earlier staged files require an
    // explicit request/confirmation; an unrelated text comment cannot pick them up.
    // Consumption is atomic and prevents their reuse by later comments.
    const files = (await ctx.db.query("threadUploadedFiles")
      .withIndex("by_task", q => q.eq("taskId", task._id)).collect())
      .filter(f => f.commentOnly && !f.commentMessageId && f.threadId === args.threadId &&
        f.userId === userId && (f.messageId === args.requestMessageId ||
          (args.includePendingFiles === true && f.uploadedAt <= request._creationTime)));
    const links: string[] = [];
    for (const file of files) {
      const url = await ctx.storage.getUrl(file.storageId);
      if (!url) throw new Error(`No se pudo recuperar el archivo ${file.filename}. Vuelve a subirlo.`);
      const label = file.filename.replace(/[\[\]\r\n]/g, " ");
      links.push(`- [${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
    }
    const message = [args.comment?.trim(), links.length ? `Archivos adjuntos:\n${links.join("\n")}` : ""].filter(Boolean).join("\n\n");
    if (!message) throw new Error("Indica un comentario o sube un archivo para agregar al requerimiento.");
    const corTaskId = validCorId(task.corTaskId);
    const status = corTaskId ? "direct_pending" : "direct_pending_task";
    const now = Date.now();
    const id = await ctx.db.insert("taskMessages", {
      taskId: task._id, userId, source: "external_agent", message,
      directExternalComment: true, requestThreadId: args.threadId,
      requestMessageId: args.requestMessageId, commentFileIds: files.map(f => f._id),
      corTaskId, corMessageSyncStatus: status, createdAt: now, updatedAt: now,
    });
    for (const file of files) await ctx.db.patch(file._id, { commentMessageId: id });
    if (corTaskId) await ctx.scheduler.runAfter(0, refs().send, { id });
    return { id, status };
  },
});

export const submit = internalAction({
  args: { threadId: v.string(), taskId: v.optional(v.string()), requestMessageId: v.string(), comment: v.optional(v.string()), includePendingFiles: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<any> => {
    try {
      const result = await ctx.runMutation(refs().save, args);
      const uncertain = result.status === "direct_uncertain";
      return { ok: true, applied: ["comment"], warnings: [uncertain
        ? "El comentario está guardado en el requerimiento; el envío a COR requiere revisión del equipo."
        : result.status === "direct_pending_task"
          ? "Se enviará a COR cuando el equipo publique la tarea."
          : result.status === "synced" ? "El comentario ya está sincronizado con COR."
          : "El comentario quedó guardado y pendiente de envío a COR."] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "No se pudo guardar el comentario." };
    }
  },
});

// Dedicated states keep these comments out of the legacy Trello sender.
export const scheduleForTask = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!usesDirectExternalComments(task) || task?.convexStatus === "deleted" || !validCorId(task?.corTaskId)) return;
    const messages = await ctx.db.query("taskMessages").withIndex("by_task", q => q.eq("taskId", args.taskId)).collect();
    for (const message of messages) {
      if (message.directExternalComment && ["direct_pending_task", "direct_pending"].includes(message.corMessageSyncStatus || "")) {
        await ctx.db.patch(message._id, { corMessageSyncStatus: "direct_pending", updatedAt: Date.now() });
        await ctx.scheduler.runAfter(0, refs().send, { id: message._id });
      }
    }
  },
});

export const claim = internalMutation({
  args: { id: v.id("taskMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.id);
    if (!message?.directExternalComment || !["direct_pending", "direct_pending_task"].includes(message.corMessageSyncStatus || "")) return null;
    const task = await ctx.db.get(message.taskId);
    if (!usesDirectExternalComments(task) || task?.convexStatus === "deleted") return null;
    const corTaskId = validCorId(task?.corTaskId);
    if (!corTaskId) return null;
    const attempt = (message.directDeliveryAttempt ?? 0) + 1;
    await ctx.db.patch(message._id, { corTaskId, directDeliveryAttempt: attempt, corMessageSyncStatus: "direct_sending", updatedAt: Date.now() });
    // A crash after POST is ambiguous: do not automatically resend.
    await ctx.scheduler.runAfter(5 * 60_000, refs().markUncertain, { id: args.id, attempt });
    return { ...message, corTaskId, attempt };
  },
});

export const finish = internalMutation({
  args: { id: v.id("taskMessages"), attempt: v.number(), success: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.id);
    if (!message?.directExternalComment || message.directDeliveryAttempt !== args.attempt || !["direct_sending", "direct_uncertain"].includes(message.corMessageSyncStatus || "")) return;
    await ctx.db.patch(args.id, {
      corMessageSyncStatus: args.success ? "synced" : "direct_uncertain",
      corSyncedAt: args.success ? Date.now() : undefined,
      corMessageSyncError: args.success ? undefined : args.error || "No se pudo confirmar la recepción en COR. Revisar antes de reenviar.",
      updatedAt: Date.now(),
    });
  },
});

export const markUncertain = internalMutation({
  args: { id: v.id("taskMessages"), attempt: v.number() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.id);
    if (message?.directExternalComment && message.directDeliveryAttempt === args.attempt && message.corMessageSyncStatus === "direct_sending") {
      await ctx.db.patch(args.id, { corMessageSyncStatus: "direct_uncertain", corMessageSyncError: "Envío sin confirmación. Revisar en COR antes de reenviar.", updatedAt: Date.now() });
    }
  },
});

export async function deliverComment(
  ctx: any,
  id: string,
  provider: Pick<ProjectManagementProvider, "name" | "postTaskMessage">,
): Promise<void> {
  // Obtain the provider before claiming, so configuration failures cannot leave
  // a message marked as sent or trigger a POST through the noop provider.
  if (provider.name !== "cor") return;
  const message = await ctx.runMutation(refs().claim, { id });
  if (!message) return;
  let result: { success: boolean; error?: string };
  try {
    result = await provider.postTaskMessage({ taskId: message.corTaskId, message: formatTrelloCommentForCOR(message.message) });
  } catch (error) {
    result = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  await ctx.runMutation(refs().finish, { id, attempt: message.attempt, success: result.success, error: result.error });
}

export const send = internalAction({
  args: { id: v.id("taskMessages") },
  handler: async (ctx, args): Promise<void> => {
    await deliverComment(ctx, args.id, getProjectManagementProvider());
  },
});

// Operational recovery only (internal mutation, never exposed to the agent).
// COR's current provider has no idempotency key or message lookup. A human must
// verify that an ambiguous POST was not received before requesting a resend.
export const retryAfterReview = internalMutation({
  args: { id: v.id("taskMessages"), confirmedAbsentInCOR: v.boolean() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.id);
    if (!message?.directExternalComment || message.corMessageSyncStatus !== "direct_uncertain") {
      throw new Error("Solo se pueden reintentar comentarios sin Trello cuyo envío requiera revisión.");
    }
    if (!args.confirmedAbsentInCOR) throw new Error("Comprueba primero que el comentario no esté publicado en COR.");
    const task = await ctx.db.get(message.taskId);
    if (!usesDirectExternalComments(task) || task?.convexStatus === "deleted") throw new Error("La tarea ya no admite esta ruta.");
    await ctx.db.patch(args.id, { corMessageSyncStatus: "direct_pending", corMessageSyncError: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, refs().send, { id: args.id });
  },
});
