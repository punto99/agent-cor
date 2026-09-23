import { getAuthUserId } from "@convex-dev/auth/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_PANEL_FILE_SIZE } from "./data/taskPanel";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
export const preflight = httpAction(async () => new Response(null, { status: 204, headers }));
export const upload = httpAction(async (ctx, request) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) return new Response(JSON.stringify({ error: "No autenticado" }), { status: 401, headers });
  const rawId = new URL(request.url).searchParams.get("uploadId");
  if (!rawId) return new Response(JSON.stringify({ error: "Falta la subida" }), { status: 400, headers });
  const uploadId = rawId as Id<"taskPanelUploads">;
  let claimed = false;
  let temporary: Id<"_storage"> | undefined;
  try {
    const ticket = await ctx.runMutation(internal.data.taskPanel.claimUpload, { uploadId, userId });
    if (ticket.state === "ready") return new Response(JSON.stringify({ uploadId }), { headers });
    claimed = true;
    // Limit bytes while streaming, before allocating/registering an oversized file.
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Archivo vacío");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PANEL_FILE_SIZE || size > ticket.size) { await reader.cancel(); throw new Error("El archivo supera el tamaño permitido"); }
      chunks.push(new Uint8Array(value));
    }
    if (size !== ticket.size) throw new Error("El archivo no se recibió completo");
    temporary = await ctx.storage.store(new Blob(chunks, { type: ticket.mimeType }));
    // Reuse the chat's binary file registration; no message or agent invocation.
    const registered = await ctx.runAction(api.data.files.registerUploadedFile, { storageId: temporary, filename: ticket.filename, mimeType: ticket.mimeType });
    temporary = undefined;
    const info = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId: registered.fileId });
    if (!info) throw new Error("No se pudo registrar el archivo");
    await ctx.runMutation(internal.data.taskPanel.finishUpload, { uploadId, userId, fileId: info.fileId, storageId: info.storageId });
    return new Response(JSON.stringify({ uploadId }), { headers });
  } catch (error) {
    if (temporary) { try { await ctx.storage.delete(temporary); } catch {} }
    if (claimed) await ctx.runMutation(internal.data.taskPanel.failUpload, { uploadId });
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "No se pudo subir el archivo" }), { status: 400, headers });
  }
});
