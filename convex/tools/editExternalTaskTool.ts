import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { usesDirectExternalComments } from "../lib/directExternalComments";

const FIELD_LABELS: Record<string, string> = {
  comment: "comentario",
};

export const editExternalTaskTool = createTool({
  description: `Editar un requerimiento ya creado por un usuario externo.
  SOLO puede agregar un comentario.
  No puede editar título, descripción, fecha de lanzamiento, categoría, marca, prioridad, estado, entregables, proyecto ni ningún otro campo.
  Si el usuario pide cambiar cualquier dato del requerimiento, no intentes editar ese campo: registra la solicitud como comentario para el equipo interno.

  Reglas obligatorias:
  - Usar solo después de que el usuario confirme el cambio.
  - Enviar solo el texto del comentario.
  - Si el usuario subió archivos en su último mensaje, usa esta herramienta igual; el sistema agregará links a esos archivos dentro del comentario.
  - Para solicitudes de cambios, usar "comment" con un texto claro de lo que el usuario pidió.
  - El backend rechazará cualquier edición directa de campos.`,
  args: z.object({
    taskId: z
      .string()
      .optional()
      .describe(
        "ID local del requerimiento. Opcional si se edita el requerimiento creado en esta misma conversación.",
      ),
    comment: z
      .string()
      .optional()
      .describe("Comentario para agregar al requerimiento con la solicitud del usuario."),
    includePendingFiles: z.boolean().optional().describe(
      "Solo para requerimientos sin categoría ni Trello: true únicamente cuando el usuario pide o confirma agregar archivos subidos en mensajes anteriores que aún no se incluyeron en un comentario. Omitir para comentarios de solo texto. Los archivos del mensaje actual se incluyen automáticamente. No tiene efecto en Trello.",
    ),
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    if (!threadId) {
      return "No pude identificar la conversación para aplicar el cambio.";
    }

    const context = await ctx.runQuery(
      internal.data.tasks.getExternalEditableTaskContext,
      { threadId, taskId: args.taskId },
    );
    const direct = context?.ok && usesDirectExternalComments(context.task);
    const requestMessageId = (ctx as typeof ctx & { promptMessageId?: string }).promptMessageId ?? ctx.messageId;
    if (direct && !requestMessageId) {
      return "No pude identificar el mensaje de este pedido. Intenta nuevamente.";
    }
    const result = await ctx.runAction(
      direct
        ? (internal as any).data.externalComments.submit
        : (internal as any).data.trello.editExternalTaskFromAgent,
      {
        threadId,
        taskId: args.taskId,
        comment: args.comment,
        ...(direct ? { requestMessageId, includePendingFiles: args.includePendingFiles } : {}),
      },
    );

    if (!result?.ok) {
      return result?.error || "No se pudo aplicar el cambio.";
    }

    const applied = Array.isArray(result.applied)
      ? result.applied.map((field: string) => FIELD_LABELS[field] || field)
      : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];

    const warningText =
      warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
    const trelloText =
      typeof result.trelloBoardUrl === "string" && result.trelloBoardUrl
        ? `\n\nTrello:\n- Tablero del requerimiento: [Abrir tablero de Trello](${result.trelloBoardUrl})`
        : "";

    return `Listo, agregué el ${applied.join(", ")} al requerimiento.${trelloText}${warningText}`;
  },
});
