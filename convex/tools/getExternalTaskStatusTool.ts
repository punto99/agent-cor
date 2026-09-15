import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const getExternalTaskStatusTool = createTool({
  description: `Consultar el último estado registrado de un requerimiento del usuario externo.
  Usa esta herramienta siempre que pregunte por el estado o avance de su tarea.
  Consulta únicamente Convex y valida los permisos. Funciona con y sin categorías o Trello.
  No modifica la tarea ni agrega comentarios. No infieras estados a partir del historial.`,
  args: z.object({
    taskId: z.string().optional().describe("ID local del requerimiento, solo si se conoce. Omitir para consultar la tarea de esta conversación."),
  }),
  handler: async (ctx, args): Promise<string> => {
    if (!ctx.threadId) return "No pude identificar la conversación para consultar el estado.";
    try {
      const result = await ctx.runQuery(
        (internal as any).data.externalTaskStatus.get,
        { threadId: ctx.threadId, taskId: args.taskId },
      );
      return JSON.stringify(result);
    } catch {
      return JSON.stringify({ ok: false, message: "No pude consultar el estado registrado en este momento. Intenta nuevamente." });
    }
  },
});
