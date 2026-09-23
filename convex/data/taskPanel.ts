import { canViewExternalRequest, isRequestsClientTask } from "../lib/externalRequestsAccess";
import { notifyTaskComment } from "../lib/commentNotifications";
import { resolvePanelComment } from "../lib/taskPanelComment";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { insertExclusiveTaskAttachment, hasTaskAccess } from "./tasks";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";

export const MAX_PANEL_FILE_SIZE = 20 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

export async function requirePanelTask(ctx: QueryCtx | MutationCtx, taskId: Id<"tasks">, userId: Id<"users"> | null) {
  if (!userId) throw new Error("No autenticado");
  const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
  const task = await ctx.db.get(taskId);
  if (!task || task.convexStatus === "deleted") throw new Error("No tenés acceso a esta tarea.");
  const allowed = external
    ? await canViewExternalRequest(ctx, userId, task)
    : await isRequestsClientTask(ctx, task) && await hasTaskAccess(ctx, task, userId);
  if (!allowed) throw new Error("No tenés acceso a esta tarea.");
  return task;
}

export const canAccessComments = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const task = await ctx.db.get(taskId);
    if (!task || task.convexStatus === "deleted") return false;
    const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId)).unique();
    return external ? await canViewExternalRequest(ctx, userId, task)
      : await isRequestsClientTask(ctx, task) && await hasTaskAccess(ctx, task, userId);
  },
});

export const prepareUpload = mutation({
  args: { taskId: v.id("tasks"), key: v.string(), filename: v.string(), mimeType: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    await requirePanelTask(ctx, args.taskId, userId);
    if (!MIME_TYPES.has(args.mimeType) || args.size <= 0 || args.size > MAX_PANEL_FILE_SIZE || !args.filename.trim() || args.filename.length > 255 || args.key.length > 100) throw new Error("Archivo inválido. Usá imágenes, PDF o Word de hasta 20 MB.");
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) throw new Error("No está configurada la dirección de subida.");
    const existing = await ctx.db.query("taskPanelUploads").withIndex("by_user_key", q => q.eq("userId", userId!).eq("key", args.key)).unique();
    if (existing && (existing.taskId !== args.taskId || existing.filename !== args.filename || existing.size !== args.size || existing.mimeType !== args.mimeType)) throw new Error("La subida ya pertenece a otra operación.");
    const uploadId = existing?._id ?? await ctx.db.insert("taskPanelUploads", { ...args, userId: userId!, state: "pending", createdAt: Date.now() });
    return { uploadId, url: `${siteUrl}/task-panel/upload?uploadId=${uploadId}`, ready: existing?.state === "ready" };
  },
});

export const claimUpload = internalMutation({
  args: { uploadId: v.id("taskPanelUploads"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.userId !== args.userId) throw new Error("Subida no autorizada.");
    await requirePanelTask(ctx, upload.taskId, args.userId);
    if (upload.state === "ready") return upload;
    if (upload.state === "uploading") throw new Error("La subida está en curso. Esperá antes de reintentar.");
    await ctx.db.patch(upload._id, { state: "uploading" });
    return upload;
  },
});
export const finishUpload = internalMutation({
  args: { uploadId: v.id("taskPanelUploads"), userId: v.id("users"), fileId: v.string(), storageId: v.string() },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.userId !== args.userId || upload.state !== "uploading") throw new Error("Subida no válida.");
    await requirePanelTask(ctx, upload.taskId, args.userId);
    await ctx.db.patch(upload._id, { state: "ready", fileId: args.fileId, storageId: args.storageId });
  },
});
export const failUpload = internalMutation({
  args: { uploadId: v.id("taskPanelUploads") },
  handler: async (ctx, { uploadId }) => { const upload = await ctx.db.get(uploadId); if (upload?.state === "uploading") await ctx.db.patch(uploadId, { state: "failed" }); },
});

export const submit = mutation({
  args: { taskId: v.id("tasks"), key: v.string(), text: v.string(), uploadIds: v.array(v.id("taskPanelUploads")), replyTo: v.optional(v.id("taskMessages")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const task = await requirePanelTask(ctx, args.taskId, userId);
    const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId!)).unique();
    const parent = args.replyTo ? await ctx.db.get(args.replyTo) : null;
    if (args.replyTo && (!parent || parent.replyTo || parent.taskId !== task._id || (external && !["external_panel", "internal_panel", "external_agent", "trello"].includes(parent.source)))) {
      throw new Error("No podés responder a este comentario.");
    }
    const text = args.text.trim();
    if ((!text && !args.uploadIds.length) || text.length > 10000 || args.uploadIds.length > 10 || args.key.length > 100 || new Set(args.uploadIds).size !== args.uploadIds.length) throw new Error("Revisá el comentario y sus archivos (máximo 10).");
    const existing = await ctx.db.query("taskPanelEntries").withIndex("by_user_key", q => q.eq("userId", userId!).eq("key", args.key)).unique();
    if (existing) {
      if (existing.taskId !== args.taskId || existing.text !== text || existing.replyTo !== args.replyTo || JSON.stringify(existing.uploadIds) !== JSON.stringify(args.uploadIds)) throw new Error("La operación ya fue guardada con otro contenido.");
      return existing._id;
    }
    const uploads = await Promise.all(args.uploadIds.map(id => ctx.db.get(id)));
    for (const upload of uploads) if (!upload || upload.userId !== userId || upload.taskId !== task._id || upload.state !== "ready" || !upload.fileId || !upload.storageId || upload.entryId) throw new Error("Uno de los archivos no pertenece a esta tarea o ya fue utilizado.");
    const entryId = await ctx.db.insert("taskPanelEntries", { ...args, text, userId: userId!, createdAt: Date.now(), trelloState: task.trelloCardId || isTrelloEnabledForCorClientId(task.corClientId) ? "waiting" : "not_applicable", corState: "waiting", nextCheckAt: Date.now() });
    const commentFiles: { filename: string; mimeType: string; url: string }[] = [];
    for (const upload of uploads) {
      if (!upload) continue;
      await insertExclusiveTaskAttachment(ctx, { taskId: task._id, panelEntryId: entryId, fileId: upload.fileId!, storageId: upload.storageId!, filename: upload.filename, mimeType: upload.mimeType, size: upload.size });
      await ctx.db.patch(upload._id, { entryId });
      const url = await ctx.storage.getUrl(upload.storageId as Id<"_storage">);
      if (!url) throw new Error("El archivo ya no está disponible.");
      commentFiles.push({ filename: upload.filename, mimeType: upload.mimeType, url });
    }
    if (text) {
      const messageId = await ctx.db.insert("taskMessages", { taskId: task._id, replyTo: args.replyTo, panelEntryId: entryId, userId: userId!, source: external ? "external_panel" : "internal_panel", message: resolvePanelComment(text, commentFiles), trelloSyncStatus: "pending", corMessageSyncStatus: task.corTaskId ? "pending" : "pending_cor_task", createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.patch(entryId, { messageId });
      await notifyTaskComment(ctx, messageId);
    }
    await ctx.scheduler.runAfter(0, internal.data.taskPanelSync.sync, { entryId });
    return entryId;
  },
});

export const detail = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    await requirePanelTask(ctx, taskId, userId);
    const external = await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", userId!)).unique();
    const attachments = await ctx.db.query("taskAttachments").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
    const messages = await ctx.db.query("taskMessages").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
    const entries = await ctx.db.query("taskPanelEntries").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
    return {
      viewerIsExternal: Boolean(external),
      attachments: await Promise.all(attachments.map(async a => ({ id: a._id, filename: a.filename, size: a.size, mimeType: a.mimeType, createdAt: a.createdAt, trelloAttachmentId: a.trelloAttachmentId, trelloUrl: a.trelloAttachmentUrl, corUrl: a.corUrl, url: await ctx.storage.getUrl(a.storageId as Id<"_storage">), entryId: a.panelEntryId }))),
      comments: await Promise.all(messages.filter(m => !external || ["external_panel", "internal_panel", "external_agent", "trello"].includes(m.source)).sort((a,b) => b.createdAt-a.createdAt).map(async m => ({ id: m._id, replyTo: m.replyTo, quote: m.userQuote, text: m.message, createdAt: m.createdAt, own: m.userId === userId, isClient: !external && (m.source === "external_agent" || Boolean(m.userId && await ctx.db.query("approvedExternalUsers").withIndex("by_user", q => q.eq("userId", m.userId!)).unique())), authorName: m.userId ? (await ctx.db.get(m.userId))?.name : undefined }))),
      entries: entries.map(e => ({ id: e._id, createdAt: e.createdAt, trelloState: e.trelloState, corState: e.corState })),
    };
  },
});

export const syncContext = internalQuery({
  args: { entryId: v.id("taskPanelEntries") },
  handler: async (ctx, { entryId }) => {
    const entry = await ctx.db.get(entryId);
    if (!entry) return null;
    const task = await ctx.db.get(entry.taskId);
    const attachments = (await ctx.db.query("taskAttachments").withIndex("by_task", q => q.eq("taskId", entry.taskId)).collect()).filter(a => a.panelEntryId === entryId);
    const message = entry.messageId ? await ctx.db.get(entry.messageId) : null;
    const parent = message?.replyTo ? await ctx.db.get(message.replyTo) : null;
    const author = parent?.userId ? await ctx.db.get(parent.userId) : null;
    // Providers receive a regular comment with context; local replies keep their structure.
    const context = parent ? `En respuesta a ${author?.name || "un comentario"}: ${parent.message.replace(/\s+/g, " ").slice(0, 240)}\n\n` : "";
    return { entry, task, attachments, message: message ? { ...message, message: context + message.message } : null };
  },
});
