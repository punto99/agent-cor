import { CHAT_MAX_TOTAL_SIZE_BYTES, CHAT_MAX_TOTAL_SIZE_MB, ChatUploadLimitError } from "../../config/chatUploads";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type PromptFile = { storageId: string; filename?: string; mimeType: string };
type FileMaps = { byUrl: Map<string, PromptFile>; bySignature: Map<string, PromptFile[]> };

// Check the actual prompt, including replayed history, before either provider is
// called. Cache metadata, but count each occurrence actually sent to the model.
export async function assertChatModelFileBudget(ctx: ActionCtx, messages: any[], files: FileMaps) {
  const sizes = new Map<string, number>();
  // Match the Gemini adapter's ordered fallback without consuming its map.
  const candidates = new Map([...files.bySignature].map(([signature, entries]) => [signature, [...entries]]));
  let total = 0;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image" && part.type !== "file") continue;
      const data = part.type === "image" ? part.image : part.data;
      const source = data instanceof URL ? data.toString() : typeof data === "string" ? data : "";
      const file = files.byUrl.get(source)
        ?? candidates.get(`${part.filename || ""}|${part.mediaType || ""}`)?.shift();
      if (!file) continue;
      if (!sizes.has(file.storageId)) {
        const metadata = await ctx.storage.getMetadata(file.storageId as Id<"_storage">);
        if (!metadata) throw new Error("Uno de los archivos del chat ya no está disponible.");
        sizes.set(file.storageId, metadata.size);
      }
      total += sizes.get(file.storageId)!;
      if (total > CHAT_MAX_TOTAL_SIZE_BYTES) {
        throw new ChatUploadLimitError(`Los archivos incluidos en esta respuesta, contando los mensajes anteriores, superan ${CHAT_MAX_TOTAL_SIZE_MB} MB. Para continuar, abrí un chat nuevo con los archivos que necesitás analizar.`);
      }
    }
  }
}
