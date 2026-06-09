import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

const FIELD_LABELS: Record<string, string> = {
  description: "descripción",
  deadline: "fecha de entrega",
  comment: "comentario",
};

export const editExternalTaskTool = createTool({
  description: `Editar un requerimiento ya creado por un usuario externo.
  SOLO puede actualizar descripción completa, fecha de entrega o agregar un comentario.
  No puede editar título, categoría, marca, prioridad, estado, entregables, proyecto ni ningún otro campo.
  Si el usuario pide cambiar un campo no permitido, no intentes editar ese campo: registra la solicitud como comentario para el equipo interno.

  Reglas obligatorias:
  - Usar solo después de que el usuario confirme el cambio.
  - Si cambia la descripción, enviar la descripción completa preservando lo anterior y agregando/modificando solo lo pedido.
  - Si cambia la fecha, usar formato YYYY-MM-DD.
  - Si agrega un comentario, enviar solo el texto del comentario.
  - Para solicitudes de cambios no permitidos, usar "comment" con un texto claro de lo que el usuario pidió.
  - El backend rechazará cualquier edición fuera de estos campos.`,
  args: z.object({
    taskId: z
      .string()
      .optional()
      .describe(
        "ID local del requerimiento. Opcional si se edita el requerimiento creado en esta misma conversación.",
      ),
    description: z
      .string()
      .optional()
      .describe("Nueva descripción completa del requerimiento."),
    deadline: z
      .string()
      .optional()
      .describe("Nueva fecha de entrega en formato YYYY-MM-DD."),
    comment: z
      .string()
      .optional()
      .describe("Comentario para agregar al requerimiento."),
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
        description: args.description,
        deadline: args.deadline,
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

    return `Listo, actualicé ${applied.join(", ")} del requerimiento.${warningText}`;
  },
});
