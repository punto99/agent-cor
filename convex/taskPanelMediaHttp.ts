import { getAuthUserId } from "@convex-dev/auth/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { trelloProvider } from "./integrations/trelloProvider";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export const preflight = httpAction(async () => new Response(null, { status: 204, headers }));
export const media = httpAction(async (ctx, request) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) return new Response("No autenticado", { status: 401, headers });
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId") as Id<"tasks"> | null;
  const attachmentId = url.searchParams.get("attachmentId");
  if (!taskId || !attachmentId) return new Response("Falta el archivo", { status: 400, headers });
  try {
    const { cardId } = await ctx.runQuery(internal.data.taskPanelMedia.context, { taskId, userId });
    if (!cardId) return new Response("Archivo no disponible", { status: 404, headers });
    // The caller supplies an ID, never an arbitrary URL. Validate card membership
    // before using the existing authenticated Trello download implementation.
    const attachments = await trelloProvider.listCardAttachments(cardId);
    const attachment = attachments.find(a => a.id === attachmentId && a.isUpload === true);
    if (!attachment) return new Response("Archivo no disponible", { status: 404, headers });
    const downloaded = await trelloProvider.downloadAttachment({ cardId, attachmentId, name: attachment.name });
    return new Response(downloaded.blob, { headers: { ...headers, "Content-Type": downloaded.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}` } });
  } catch {
    return new Response("No se pudo cargar el archivo", { status: 403, headers });
  }
});
