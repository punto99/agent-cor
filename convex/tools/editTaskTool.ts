// convex/tools/editTaskTool.ts
// Tool para editar una task existente en COR y en la base de datos local
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const editTaskTool = createTool({
  description: `Editar una task/requerimiento existente en COR y en la base de datos local.
  Usar esta herramienta cuando el usuario quiera modificar informacion de un requerimiento que ya fue creado.
  
  El usuario puede proporcionar:
  - El COR ID de la task (ej: 11301144) - RECOMENDADO, busca directamente en COR
  - El ID local de la task
  - O si acaba de crear una task en esta conversacion, se encuentra automaticamente por el threadId
  
  IMPORTANTE: Solo actualiza los campos que el usuario quiere cambiar.
  La descripcion contiene toda la info del brief (tipo, marca, objetivo, kpis, etc.).
  Si el usuario quiere cambiar algo de la descripcion, primero usa getTask para ver el contenido actual,
  luego envia la descripcion completa actualizada.`,
  args: z.object({
    corTaskId: z.string().optional().describe("ID de la task en COR (ej: 11301144) - PREFERIDO"),
    taskId: z.string().optional().describe("ID local de la task (opcional si se usa corTaskId o thread)"),
    title: z.string().optional().describe("Nuevo titulo del requerimiento"),
    description: z.string().optional().describe("Nueva descripcion completa (contiene toda la info del brief)"),
    deadline: z.string().optional().describe("Nueva fecha limite"),
    priority: z.number().optional().describe("Nueva prioridad: 0=Baja, 1=Media, 2=Alta, 3=Urgente"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[EditTask] EDITANDO TASK");
    console.log("========================================");
    console.log("[EditTask] Datos recibidos:", JSON.stringify(args, null, 2));
    
    try {
      const threadId = ctx.threadId;
      let taskIdToEdit = args.taskId;
      let task = null;
      let corTaskData = null;
      
      // Obtener el userId del thread actual para verificar permisos
      let currentUserId = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[EditTask] Usuario actual: ${currentUserId}`);
      }
      
      // PRIORIDAD 1: Si se proporciona corTaskId, buscar por COR ID
      if (args.corTaskId) {
        console.log(`[EditTask] 🔍 Buscando task por COR ID: ${args.corTaskId}`);
        
        // Primero, obtener la task desde COR para ver su estado actual
        const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
          corTaskId: parseInt(args.corTaskId),
        });
        
        if (!corResult.success || !corResult.task) {
          console.log(`[EditTask] ❌ Task no encontrada en COR: ${corResult.error}`);
          return `No se encontró ninguna task con el COR ID: ${args.corTaskId} en el sistema COR.

Posibles causas:
- El ID no existe o fue eliminado
- No tienes permisos para ver esta task
- Error de conexión con COR

Por favor verifica el ID e intenta de nuevo.`;
        }
        
        corTaskData = corResult.task;
        console.log(`[EditTask] ✅ Task encontrada en COR:`, JSON.stringify(corTaskData, null, 2));
        
        // Buscar la task local por el COR ID
        task = await ctx.runQuery(internal.data.tasks.getTaskByCORIdInternal, { 
          corTaskId: args.corTaskId 
        });
        
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] 📋 Task local encontrada: ${taskIdToEdit}`);
        } else {
          console.log(`[EditTask] ⚠️ Task existe en COR pero no hay registro local`);
          // La task existe en COR pero no localmente - igual podemos editarla en COR
        }
      }
      // PRIORIDAD 2: Si se proporciona taskId local, buscar por ID
      else if (taskIdToEdit) {
        console.log(`[EditTask] Buscando task por ID local: ${taskIdToEdit}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToEdit });
        
        if (!task) {
          return `No se encontró ninguna task con el ID local: ${taskIdToEdit}. Verifica que el ID sea correcto.`;
        }
        
        // Verificar permisos
        if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
          console.log(`[EditTask] Permiso denegado: usuario ${currentUserId} intentó editar task de ${task.createdBy}`);
          return "No tienes permiso para editar esta task. Solo puedes modificar requerimientos creados por ti.";
        }
        
        // Si la task tiene COR ID, obtener datos de COR
        if (task.corTaskId) {
          const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
            corTaskId: parseInt(task.corTaskId),
          });
          if (corResult.success && corResult.task) {
            corTaskData = corResult.task;
          }
        }
      } 
      // PRIORIDAD 3: Buscar por threadId
      else if (threadId) {
        console.log(`[EditTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] Task encontrada: ${taskIdToEdit}`);
          
          // Si la task tiene COR ID, obtener datos de COR
          if (task.corTaskId) {
            const corResult = await ctx.runAction(internal.integrations.cor.getTaskFromCOR, {
              corTaskId: parseInt(task.corTaskId),
            });
            if (corResult.success && corResult.task) {
              corTaskData = corResult.task;
            }
          }
        }
      }
      
      // Si no encontramos ninguna task
      if (!taskIdToEdit && !args.corTaskId) {
        return "Error: No se pudo identificar la task a editar. Por favor proporciona el COR ID de la task (ej: 11301144), el ID local, o asegurate de estar en la conversacion correcta.";
      }
      
      // Construir objeto con solo los campos a actualizar
      const updates: Record<string, string | number | undefined> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.deadline !== undefined) updates.deadline = args.deadline;
      if (args.priority !== undefined) updates.priority = args.priority;
      
      if (Object.keys(updates).length === 0) {
        // Si no hay campos para actualizar pero tenemos datos de COR, mostrar la task actual
        if (corTaskData) {
          return `📋 **Task actual en COR (ID: ${corTaskData.id})**

**Título:** ${corTaskData.title}
**Descripción:** ${corTaskData.description || "Sin descripción"}
**Estado:** ${corTaskData.status}
**Prioridad:** ${corTaskData.priority}
**Deadline:** ${corTaskData.deadline || "Sin fecha límite"}

¿Qué cambios quieres hacer?`;
        }
        return "No se proporcionaron campos para actualizar.";
      }
      
      console.log(`[EditTask] Campos a actualizar:`, JSON.stringify(updates, null, 2));
      
      // ACTUALIZAR EN COR PRIMERO (si tenemos COR ID)
      let corUpdateResult = null;
      const corIdToUpdate = args.corTaskId || task?.corTaskId;
      
      if (corIdToUpdate) {
        console.log(`[EditTask] 🔄 Actualizando en COR (Task ID: ${corIdToUpdate})...`);
        
        try {
          corUpdateResult = await ctx.runAction(internal.integrations.cor.updateTaskInCOR, {
            corTaskId: parseInt(corIdToUpdate),
            title: args.title,
            description: args.description,
            deadline: args.deadline,
            priority: args.priority,
          });
          
          if (corUpdateResult.success) {
            console.log("[EditTask] ✅ Task actualizada en COR");
          } else {
            console.error("[EditTask] ⚠️ Error al actualizar en COR:", corUpdateResult.error);
          }
        } catch (corError) {
          console.error("[EditTask] ⚠️ Error al actualizar en COR:", corError);
        }
      }
      
      // ACTUALIZAR EN BASE DE DATOS LOCAL (si existe registro local)
      if (taskIdToEdit) {
        await ctx.runMutation(internal.data.tasks.updateTaskInternal, {
          taskId: taskIdToEdit,
          updates,
        });
        console.log(`[EditTask] ✅ Task ${taskIdToEdit} actualizada localmente`);
      }
      
      console.log("========================================\n");
      
      const updatedFields = Object.keys(updates).join(", ");
      
      // Construir respuesta según el resultado
      let corStatus = "";
      if (corIdToUpdate) {
        if (corUpdateResult?.success) {
          corStatus = `\n✅ Cambios aplicados en COR (ID: ${corIdToUpdate})`;
        } else if (corUpdateResult) {
          corStatus = `\n⚠️ No se pudieron aplicar los cambios en COR: ${corUpdateResult.error}`;
        }
      }
      
      return `✅ Task actualizada exitosamente!

**ID de tarea COR:** ${corIdToUpdate || "No sincronizada"}
**Campos actualizados:** ${updatedFields}${corStatus}

¿Hay algo más que quieras modificar?`;
    } catch (error) {
      console.error("[EditTask] Error actualizando task:", error);
      return `Error al actualizar la task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
