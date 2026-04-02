// convex/tools/getTaskTool.ts
// Tool para ver los detalles de una task existente
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { PRIORITY_LABELS } from "../lib/briefFormat";

export const getTaskTool = createTool({
  description: `Ver los detalles completos de una task/requerimiento existente en la base de datos.
  Usar esta herramienta cuando el usuario quiera ver, consultar o revisar la informacion de un requerimiento.
  El usuario puede proporcionar el ID de la task o, si acaba de crear una task en esta conversacion, 
  el agente puede encontrarla automaticamente por el threadId.
  
  IMPORTANTE: Usar esta herramienta ANTES de editar para conocer los valores actuales.`,
  args: z.object({
    taskId: z.string().optional().describe("ID de la task a consultar (opcional si se busca por thread)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[GetTask] CONSULTANDO TASK");
    console.log("========================================");
    
    try {
      const threadId = ctx.threadId;
      let task = null;
      
      // Obtener el userId del thread actual para verificar permisos
      let currentUserId = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[GetTask] Usuario actual: ${currentUserId}`);
      }
      
      // Si se proporciona taskId, buscar directamente por ID
      if (args.taskId) {
        console.log(`[GetTask] Buscando task por ID: ${args.taskId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: args.taskId });
        
        if (!task) {
          console.log(`[GetTask] Task no encontrada con ID: ${args.taskId}`);
          return `No se encontró ninguna task con el ID: ${args.taskId}. Verifica que el ID sea correcto.`;
        }
        
        // Verificar permisos: el usuario solo puede ver tasks creadas por él
        if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
          console.log(`[GetTask] Permiso denegado: usuario ${currentUserId} intentó acceder a task de ${task.createdBy}`);
          return "No tienes permiso para ver esta task. Solo puedes consultar requerimientos creados por ti.";
        }
      } else if (threadId) {
        // Si no hay taskId, buscar por threadId
        console.log(`[GetTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        
        if (!task) {
          console.log(`[GetTask] No hay task asociada al thread: ${threadId}`);
          return "No se encontró ninguna task asociada a esta conversación. ¿Deseas crear un nuevo requerimiento?";
        }
      } else {
        return "Error: No se pudo identificar la task a consultar. Por favor proporciona el ID de la task o asegúrate de estar en la conversación correcta.";
      }
      
      // Formatear la respuesta
      const corInfo = task.corTaskId 
        ? `**ID de tarea COR:** ${task.corTaskId} ✅`
        : "**Estado COR:** Pendiente de sincronización";
      
      const priorityLabel = PRIORITY_LABELS[task.priority ?? 1] || "Media";
      
      const taskInfo = `
📋 **Detalles del Requerimiento**

${corInfo}

**Título:** ${task.title || "Sin título"}
**Estado:** ${task.status || "Sin estado"}
**Prioridad:** ${priorityLabel}
**Fecha Límite:** ${task.deadline || "No especificada"}

**Descripción del Brief:**
${task.description || "Sin descripción"}

**Archivos adjuntos:** ${task.fileIds?.length || 0}
`;
      console.log("[GetTask] Task encontrada y formateada exitosamente");
      console.log("========================================\n");
      return taskInfo;
      
    } catch (error) {
      console.error("[GetTask] Error al consultar task:", error);
      return `Error al consultar la task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
