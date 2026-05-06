// convex/tools/attachFileToTaskTool.ts
// Tool para asociar archivos subidos en el chat a una task existente.
import { createTool, listMessages } from "@convex-dev/agent";
import { z } from "zod";
import { components, internal } from "../_generated/api";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractFileIdsFromMessage(msg: any): string[] {
  const ids: string[] = [];

  if (Array.isArray(msg.fileIds)) {
    ids.push(...msg.fileIds);
  }

  if (Array.isArray(msg.metadata?.fileIds)) {
    ids.push(...msg.metadata.fileIds);
  }

  if (Array.isArray(msg.message?.metadata?.fileIds)) {
    ids.push(...msg.message.metadata.fileIds);
  }

  return unique(ids);
}

function getMessageCreationTime(msg: any): number {
  return typeof msg._creationTime === "number" ? msg._creationTime : 0;
}

function isExtractedImageFile(
  fileInfo: { filename: string },
  allFileInfos: Array<{ filename: string }>,
): boolean {
  // Word/PDF preprocessing may add auxiliary files named
  // "<original filename>-img-0.png". Those are for model context, not task attachments.
  return allFileInfos.some((candidate) => {
    if (candidate.filename === fileInfo.filename) return false;
    return fileInfo.filename.startsWith(`${candidate.filename}-img-`);
  });
}

export const attachFileToTaskTool = createTool({
  description: `Adjuntar archivos subidos en el chat a una task/requerimiento existente.
  Usar esta herramienta cuando el usuario pida agregar, adjuntar o asociar un archivo a una task ya creada.

  La herramienta toma automaticamente los archivos del ultimo mensaje del usuario que tenga archivos adjuntos.
  Si la task solo existe en Convex, crea el attachment local y queda pendiente para cuando se publique.
  Si la task ya esta publicada en COR, crea el attachment local y programa la subida del archivo a COR.

  No usar editTask para adjuntar archivos; los adjuntos tienen su propio flujo.`,
  args: z.object({
    corTaskId: z.string().optional().describe("ID de la task en COR (ej: 11301144)"),
    taskId: z.string().optional().describe("ID local de la task en Convex"),
    fileIds: z.array(z.string()).optional().describe("Opcional. IDs especificos de archivos ya subidos; normalmente no se envia porque la tool toma el ultimo archivo del chat."),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[AttachFileToTask] ADJUNTANDO ARCHIVOS A TASK");
    console.log("========================================");
    console.log("[AttachFileToTask] Datos recibidos:", JSON.stringify(args, null, 2));

    try {
      const threadId = ctx.threadId;
      let taskIdToUpdate = args.taskId;
      let task: any = null;

      let currentUserId: string | null = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[AttachFileToTask] Usuario actual: ${currentUserId}`);
      }

      if (args.corTaskId) {
        console.log(`[AttachFileToTask] Buscando task por COR ID: ${args.corTaskId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByCORIdInternal, {
          corTaskId: args.corTaskId,
        });

        if (!task) {
          return `No se encontró ninguna task con el COR ID: ${args.corTaskId}. Verifica el ID e intenta de nuevo.`;
        }

        taskIdToUpdate = task._id;
      } else if (taskIdToUpdate) {
        console.log(`[AttachFileToTask] Buscando task por ID local: ${taskIdToUpdate}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToUpdate });

        if (!task) {
          return `No se encontró ninguna task con el ID local: ${taskIdToUpdate}. Verifica que el ID sea correcto.`;
        }
      } else if (threadId) {
        console.log(`[AttachFileToTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task) {
          taskIdToUpdate = task._id;
        }
      }

      if (!task || !taskIdToUpdate) {
        return "No se pudo identificar la task a la que quieres adjuntar el archivo. Enviame el ID local de la task o el ID de COR.";
      }

      if (task.corClientId && currentUserId) {
        const client = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
          corClientId: task.corClientId,
        });

        if (client) {
          const isAuthorized = await ctx.runQuery(internal.data.corClients.isUserAuthorizedForClient, {
            clientId: client._id,
            userId: currentUserId as any,
          });

          if (!isAuthorized) {
            return `No tienes permisos para adjuntar archivos a tasks del cliente "${task.corClientName || "desconocido"}".`;
          }
        }
      } else if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
        return "No tienes permiso para adjuntar archivos a esta task.";
      }

      let fileIds = unique(args.fileIds || []);

      if (fileIds.length === 0) {
        if (!threadId) {
          return "No pude encontrar archivos en esta conversación. Sube el archivo en el chat y vuelve a pedirme que lo adjunte.";
        }

        const messagesResult = await listMessages(ctx, components.agent, {
          threadId,
          paginationOpts: { cursor: null, numItems: 50 },
        });

        const userMessagesWithFiles = messagesResult.page
          .filter((msg: any) => msg.message?.role === "user")
          .map((msg: any) => ({ msg, fileIds: extractFileIdsFromMessage(msg) }))
          .filter((entry) => entry.fileIds.length > 0)
          .sort((a, b) => getMessageCreationTime(b.msg) - getMessageCreationTime(a.msg));

        if (userMessagesWithFiles.length > 0) {
          fileIds = userMessagesWithFiles[0].fileIds;
        }
      }

      if (fileIds.length === 0) {
        return "No encontré ningún archivo subido en esta conversación. Sube el archivo y dime nuevamente a qué task quieres adjuntarlo.";
      }

      const existingAttachments = await ctx.runQuery(internal.data.tasks.getTaskAttachments, {
        taskId: taskIdToUpdate as any,
      });
      const existingFileIds = new Set(existingAttachments.map((att: any) => att.fileId));

      const allResolvedFiles: Array<{
        fileId: string;
        storageId: string;
        filename: string;
        mimeType: string;
        size?: number;
      }> = [];
      const unresolvedFileIds: string[] = [];

      for (const fileId of fileIds) {
        const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
        if (!fileInfo) {
          unresolvedFileIds.push(fileId);
          continue;
        }

        allResolvedFiles.push(fileInfo);
      }

      const filesToAttach = allResolvedFiles
        .filter((fileInfo) => !existingFileIds.has(fileInfo.fileId))
        .filter((fileInfo) => !isExtractedImageFile(fileInfo, allResolvedFiles));

      if (filesToAttach.length === 0) {
        if (allResolvedFiles.length === 0 && unresolvedFileIds.length > 0) {
          return "No pude resolver el archivo subido. Por favor vuelve a subirlo e intenta de nuevo.";
        }

        return "El archivo ya estaba adjunto a esta task; no hice cambios.";
      }

      for (const fileInfo of filesToAttach) {
        await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
          taskId: taskIdToUpdate as any,
          fileId: fileInfo.fileId,
          storageId: fileInfo.storageId,
          filename: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          size: fileInfo.size,
        });
        console.log(`[AttachFileToTask] Attachment creado: ${fileInfo.filename}`);
      }

      let corSyncMessage = "";
      if (task.corTaskId) {
        await ctx.runMutation(internal.data.tasks.scheduleTaskSyncToCOR, {
          taskId: taskIdToUpdate as any,
          changedFields: [],
        });
        corSyncMessage = `\nTambién programé la subida a COR para la task ${task.corTaskId}.`;
      }

      const fileList = filesToAttach.map((fileInfo) => `- ${fileInfo.filename}`).join("\n");

      console.log(`[AttachFileToTask] ${filesToAttach.length} archivo(s) adjuntado(s)`);
      console.log("========================================\n");

      return `Archivo${filesToAttach.length > 1 ? "s" : ""} adjuntado${filesToAttach.length > 1 ? "s" : ""} correctamente a la task "${task.title}".${corSyncMessage}\n\n${fileList}`;
    } catch (error) {
      console.error("[AttachFileToTask] Error adjuntando archivos:", error);
      return `Error al adjuntar el archivo: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
