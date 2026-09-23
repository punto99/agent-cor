import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { requirePanelTask } from "./taskPanel";
import { trelloProvider } from "../integrations/trelloProvider";

export const context = internalQuery({
  args: { taskId: v.id("tasks"), userId: v.id("users") },
  handler: async (ctx, { taskId, userId }) => {
    const task = await requirePanelTask(ctx, taskId, userId);
    return { cardId: task.trelloCardId, siteUrl: process.env.CONVEX_SITE_URL };
  },
});

export const list = action({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }): Promise<Array<{ id: string; filename: string; sourceUrl: string; mimeType: string; size?: number; createdAt?: string; mediaUrl: string | null; isUpload: boolean }>> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");
    const { cardId, siteUrl } = await ctx.runQuery(internal.data.taskPanelMedia.context, { taskId, userId });
    if (!cardId) return [];
    const attachments = await trelloProvider.listCardAttachments(cardId);
    return attachments.map(a => ({
      id: a.id, filename: a.name, sourceUrl: a.url,
      mimeType: a.mimeType ?? "application/octet-stream", size: a.bytes,
      createdAt: a.date, isUpload: a.isUpload === true,
      mediaUrl: a.isUpload && siteUrl ? `${siteUrl}/task-panel/media?taskId=${taskId}&attachmentId=${encodeURIComponent(a.id)}` : null,
    }));
  },
});
