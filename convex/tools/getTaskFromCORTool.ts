// convex/tools/getTaskFromCORTool.ts
// Tool para consultar una task directamente desde el sistema externo
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { getProjectManagementProvider } from "../integrations/registry";

export const getTaskFromCORTool = createTool({
  description: `Consultar los detalles de una task directamente desde el sistema COR.
  Usar esta herramienta cuando:
  - El usuario quiere ver los detalles de una task usando su COR ID
  - El usuario quiere verificar el estado actual de una task en COR
  - Antes de editar una task, para ver su contenido actual
  
  Recibe el ID numerico de la task en COR (ej: 11301144).`,
  args: z.object({
    corTaskId: z.string().describe("ID de la task en COR (ej: 11301144)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log(`[GetTaskFromCOR] 🔍 Consultando task COR ID: ${args.corTaskId}`);
    
    try {
      const provider = getProjectManagementProvider();
      const task = await provider.getTask(parseInt(args.corTaskId));
      
      if (!task) {
        console.log(`[GetTaskFromCOR] ❌ Task no encontrada`);
        return `No se encontró ninguna task con el COR ID: ${args.corTaskId}

Posibles causas:
- El ID no existe o fue eliminado
- No tienes permisos para ver esta task
- Error de conexión con COR

Por favor verifica el ID e intenta de nuevo.`;
      }
      
      console.log(`[GetTaskFromCOR] ✅ Task encontrada:`, task.title);
      
      // Mapear prioridad a texto legible
      const prioridadTexto = ["Baja", "Media", "Alta", "Urgente"][task.priority ?? 1] || "Media";
      
      // Formatear fecha si existe
      let deadlineTexto = "Sin fecha límite";
      if (task.deadline) {
        const fecha = new Date(task.deadline);
        deadlineTexto = fecha.toLocaleDateString('es-ES', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      }
      
      return `📋 **Task en COR (ID: ${task.id})**

**Título:** ${task.title}
**Descripción:** ${task.description || "Sin descripción"}
**Estado:** ${task.status || "Sin estado"}
**Prioridad:** ${prioridadTexto}
**Deadline:** ${deadlineTexto}
**Proyecto ID:** ${task.projectId}

¿Qué te gustaría hacer con esta task?`;
    } catch (error) {
      console.error(`[GetTaskFromCOR] ❌ Error:`, error);
      return `Error al consultar la task en COR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
