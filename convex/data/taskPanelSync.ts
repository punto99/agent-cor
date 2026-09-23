import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { trelloProvider } from "../integrations/trelloProvider";
import { getProjectManagementProvider } from "../integrations/registry";
import { formatPanelCommentForCOR } from "../lib/taskPanelComment";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";
import type { ActionCtx } from "../_generated/server";
import type { ProjectManagementProvider } from "../integrations/types";
import type { Id } from "../_generated/dataModel";

const DONE_AT = Number.MAX_SAFE_INTEGER;
const LEASE_MS = 10 * 60 * 1000;
export const claim = internalMutation({
  args: { entryId: v.id("taskPanelEntries") },
  handler: async (ctx, { entryId }) => {
    const entry = await ctx.db.get(entryId);
    if (!entry || (entry.leaseUntil ?? 0) > Date.now()) return false;
    // A crashed/expired sender may already have written remotely. Never blindly resend.
    const trelloState = entry.trelloState === "sending" ? "needs_review" : entry.trelloState;
    const corState = entry.corState === "sending" ? "needs_review" : entry.corState;
    if (trelloState !== "waiting" && corState !== "waiting") {
      await ctx.db.patch(entryId, { trelloState, corState, leaseUntil: undefined, nextCheckAt: DONE_AT });
      return false;
    }
    await ctx.db.patch(entryId, { trelloState, corState, leaseUntil: Date.now() + LEASE_MS, nextCheckAt: Date.now() + LEASE_MS });
    return true;
  },
});
export const setDestination = internalMutation({
  args: { entryId: v.id("taskPanelEntries"), destination: v.union(v.literal("trello"), v.literal("cor")), state: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { entryId, destination, state, error }) => {
    await ctx.db.patch(entryId, destination === "trello" ? { trelloState: state, trelloError: error } : { corState: state, corError: error });
  },
});
export const release = internalMutation({
  args: { entryId: v.id("taskPanelEntries") },
  handler: async (ctx, { entryId }) => {
    const entry = await ctx.db.get(entryId);
    if (entry) await ctx.db.patch(entryId, { leaseUntil: undefined, nextCheckAt: entry.trelloState === "waiting" || entry.corState === "waiting" ? Date.now() + 60000 : DONE_AT });
  },
});

// Separate consumer for panel-owned rows. Legacy chat and publication consumers
// exclude only panelEntryId rows, so they cannot race this sender.
type SyncProviders = {
  trello: Pick<typeof trelloProvider, "addCardAttachment" | "addCommentToCard">;
  cor: () => Pick<ProjectManagementProvider, "getTask" | "uploadTaskAttachment" | "postTaskMessage">;
};
export async function syncEntry(ctx: ActionCtx, entryId: Id<"taskPanelEntries">, providers: SyncProviders = { trello: trelloProvider, cor: getProjectManagementProvider }): Promise<void> {
    if (!await ctx.runMutation(internal.data.taskPanelSync.claim, { entryId })) return;
    try {
      for (const destination of ["trello", "cor"] as const) {
        const context = await ctx.runQuery(internal.data.taskPanel.syncContext, { entryId });
        if (!context) return;
        const { entry, task, attachments, message } = context;
        if (entry[destination === "trello" ? "trelloState" : "corState"] !== "waiting") continue;
        const setState = (state: string, error?: string) => ctx.runMutation(internal.data.taskPanelSync.setDestination, { entryId, destination, state, error });
        if (!task || task.convexStatus === "deleted") { await setState("needs_review", "La tarea ya no está disponible."); continue; }
        if (destination === "trello" && !task.trelloCardId && !isTrelloEnabledForCorClientId(task.corClientId)) { await setState("not_applicable"); continue; }
        if (destination === "trello" ? !task.trelloCardId : !task.corTaskId) continue;
        // Wait for COR publishing to finish; never mutate its status/description/hash.
        if (destination === "cor" && ["syncing", "retrying"].includes(task.corSyncStatus ?? "")) continue;
        let sending = false;
        let terminal = false;
        try {
          const provider = providers.cor();
          if (destination === "cor") {
            if (!task.corProjectId) throw new Error("Falta el proyecto asociado en COR.");
            const remoteTask = await provider.getTask(Number(task.corTaskId));
            if (!remoteTask || remoteTask.projectId !== task.corProjectId) { await setState("needs_review", "La tarea no coincide con su proyecto en COR."); continue; }
          }
          for (const attachment of attachments) {
            if (destination === "trello" ? attachment.trelloAttachmentId : attachment.corAttachmentId) continue;
            const blob = await ctx.storage.get(attachment.storageId as Id<"_storage">);
            if (!blob) { terminal = true; throw new Error("El archivo guardado no está disponible."); }
            await setState("sending"); sending = true;
            if (destination === "trello") {
              const result = await providers.trello.addCardAttachment({ cardId: task.trelloCardId!, name: attachment.filename, file: blob });
              await ctx.runMutation(internal.data.tasks.updateAttachmentTrelloSync, { attachmentId: attachment._id, trelloAttachmentId: result.id, trelloAttachmentUrl: result.url });
            } else {
              const result = await provider.uploadTaskAttachment({ taskId: Number(task.corTaskId), fileBuffer: await blob.arrayBuffer(), filename: attachment.filename, mimeType: attachment.mimeType });
              if (!result.success || !result.attachment) throw new Error(result.error || "No se pudo confirmar el adjunto en COR.");
              await ctx.runMutation(internal.data.tasks.updateAttachmentCORSync, { attachmentId: attachment._id, corAttachmentId: result.attachment.id, corUrl: result.attachment.url });
            }
          }
          if (message && (destination === "trello" ? !message.trelloCommentId : message.corMessageSyncStatus !== "synced")) {
            await setState("sending"); sending = true;
            if (destination === "trello") {
              const result = await providers.trello.addCommentToCard({ cardId: task.trelloCardId!, text: message.message });
              await ctx.runMutation(internal.data.tasks.updateTaskMessageSyncStatusInternal, { taskMessageId: message._id, trelloCommentId: result.id, trelloSyncStatus: "synced" });
            } else {
              const result = await provider.postTaskMessage({ taskId: Number(task.corTaskId), message: formatPanelCommentForCOR(message.message) });
              if (!result.success) throw new Error(result.error || "No se pudo confirmar el comentario en COR.");
              await ctx.runMutation(internal.data.tasks.updateTaskMessageSyncStatusInternal, { taskMessageId: message._id, corTaskId: Number(task.corTaskId), corMessageSyncStatus: "synced" });
            }
          }
          await setState("synced");
        } catch (error) {
          // Only reads can be retried automatically. Ambiguous writes stay saved
          // for review to avoid duplicating a remote attachment/comment.
          await setState(sending || terminal ? "needs_review" : "waiting", error instanceof Error ? error.message : "Error de sincronización");
        }
      }
    } finally {
      await ctx.runMutation(internal.data.taskPanelSync.release, { entryId });
    }
}
export const sync = internalAction({
  args: { entryId: v.id("taskPanelEntries") },
  handler: async (ctx, { entryId }): Promise<void> => syncEntry(ctx, entryId),
});
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("taskPanelEntries").withIndex("by_next_check", q => q.lte("nextCheckAt", Date.now())).take(50);
    for (const entry of entries) await ctx.scheduler.runAfter(0, internal.data.taskPanelSync.sync, { entryId: entry._id });
  },
});
