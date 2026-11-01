import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Match storeFile's hash/name deduplication without downloading or copying bytes.
// Only a redundant upload may be deleted; the canonical storage object stays alive.
export async function registerStoredAgentFile(
  ctx: ActionCtx,
  args: { storageId: Id<"_storage">; filename: string; mimeType: string },
) {
  const metadata = await ctx.storage.getMetadata(args.storageId);
  if (!metadata) throw new Error("Archivo no encontrado en storage");

  const hash = metadata.sha256;
  const existing = await ctx.runMutation(components.agent.files.useExistingFile, {
    hash, filename: args.filename,
  });
  const registered = existing ?? await ctx.runMutation(components.agent.files.addFile, {
    storageId: args.storageId, hash, filename: args.filename, mimeType: args.mimeType,
  });
  const storageId = registered.storageId as Id<"_storage">;
  const url = await ctx.storage.getUrl(storageId);
  if (!url) throw new Error("El archivo registrado no está disponible en storage");

  if (storageId !== args.storageId) await ctx.storage.delete(args.storageId);
  return { fileId: registered.fileId, storageId, url, size: metadata.size };
}
