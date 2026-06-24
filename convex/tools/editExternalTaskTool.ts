import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

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
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    if (!threadId) {
      return "No pude identificar la conversación para aplicar el cambio.";
    }

    const result = await ctx.runAction(
      (internal as any).data.trello.editExternalTaskFromAgent,
      {
        threadId,
        taskId: args.taskId,
        comment: args.comment,
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

    return `Listo, agregué el ${applied.join(", ")} al requerimiento.${warningText}`;
  },
});
