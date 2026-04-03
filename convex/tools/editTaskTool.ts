// convex/tools/editTaskTool.ts
// Tool para editar una task existente en Convex y sincronizar con COR si está publicada.
// Mantiene la lógica de edición quirúrgica de description y sincronización bidireccional.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";
import { PRIORITY_LABELS } from "../lib/briefFormat";

export const editTaskTool = createTool({
  description: `Editar una task/requerimiento existente.
  Usar esta herramienta cuando el usuario quiera modificar informacion de un requerimiento que ya fue creado.
  
  IMPORTANTE — FLUJO OBLIGATORIO ANTES DE EDITAR:
  1. Primero usa "getTask" para ver la task completa actual
  2. Muestra al usuario la task completa con los cambios propuestos resaltados
  3. Espera confirmación explícita del usuario
  4. Solo entonces usa esta herramienta para aplicar los cambios
  
  El usuario puede proporcionar:
  - El COR ID de la task (ej: 11301144) - busca en COR y local
  - El ID local de la task
  - O si acaba de crear una task en esta conversacion, se encuentra automaticamente por el threadId
  
  Solo actualiza los campos que el usuario quiere cambiar.
  La descripcion contiene toda la info del brief (tipo, marca, objetivo, kpis, etc.).
  Si el usuario quiere cambiar algo de la descripcion, primero usa getTask para ver el contenido actual,
  luego envia SOLO la parte modificada quirurgicamente — nunca reescribas toda la descripcion.
  
  Si la task está publicada en COR, los cambios se sincronizarán automáticamente.`,
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
      let task: any = null;
      let corTaskData: any = null;
      
      // Obtener el userId del thread actual para verificar permisos
      let currentUserId: string | null = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[EditTask] Usuario actual: ${currentUserId}`);
      }
      
      // ====================================================
      // BUSCAR LA TASK (por corTaskId, taskId local, o threadId)
      // ====================================================
      
      // PRIORIDAD 1: Si se proporciona corTaskId, buscar por COR ID
      if (args.corTaskId) {
        console.log(`[EditTask] 🔍 Buscando task por COR ID: ${args.corTaskId}`);
        
        // Buscar la task local por el COR ID
        task = await ctx.runQuery(internal.data.tasks.getTaskByCORIdInternal, { 
          corTaskId: args.corTaskId 
        });
        
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] 📋 Task local encontrada: ${taskIdToEdit}`);
        }
        
        // Obtener datos actuales de COR
        try {
          const provider = getProjectManagementProvider();
          corTaskData = await provider.getTask(parseInt(args.corTaskId));
          if (corTaskData) {
            console.log(`[EditTask] ✅ Task encontrada en COR: ${corTaskData.title}`);
          }
        } catch (err) {
          console.log(`[EditTask] ⚠️ No se pudo leer task de COR: ${err}`);
        }
        
        if (!task && !corTaskData) {
          return `No se encontró ninguna task con el COR ID: ${args.corTaskId}. Verifica el ID e intenta de nuevo.`;
        }
      }
      // PRIORIDAD 2: Si se proporciona taskId local
      else if (taskIdToEdit) {
        console.log(`[EditTask] Buscando task por ID local: ${taskIdToEdit}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToEdit });
        
        if (!task) {
          return `No se encontró ninguna task con el ID local: ${taskIdToEdit}. Verifica que el ID sea correcto.`;
        }
        
        // Verificar permisos
        if (currentUserId && task.createdBy && task.createdBy !== currentUserId) {
          return "No tienes permiso para editar esta task. Solo puedes modificar requerimientos creados por ti.";
        }
        
        // Si la task tiene COR ID, obtener datos del sistema externo
        if (task.corTaskId) {
          try {
            const provider = getProjectManagementProvider();
            corTaskData = await provider.getTask(parseInt(task.corTaskId));
          } catch (err) {
            console.log(`[EditTask] ⚠️ No se pudo leer task de COR: ${err}`);
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
          
          if (task.corTaskId) {
            try {
              const provider = getProjectManagementProvider();
              corTaskData = await provider.getTask(parseInt(task.corTaskId));
            } catch (err) {
              console.log(`[EditTask] ⚠️ No se pudo leer task de COR: ${err}`);
            }
          }
        }
      }
      
      // Si no encontramos ninguna task
      if (!taskIdToEdit && !args.corTaskId) {
        return "Error: No se pudo identificar la task a editar. Por favor proporciona el COR ID de la task (ej: 11301144), el ID local, o asegurate de estar en la conversacion correcta.";
      }
      
      // ====================================================
      // CONSTRUIR CAMPOS A ACTUALIZAR
      // ====================================================
      const updates: Record<string, string | number | undefined> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.deadline !== undefined) updates.deadline = args.deadline;
      if (args.priority !== undefined) updates.priority = args.priority;
      
      if (Object.keys(updates).length === 0) {
        // Si no hay campos para actualizar, mostrar la task actual
        const taskTitle = task?.title || corTaskData?.title || "Sin título";
        const taskDesc = task?.description || corTaskData?.description || "Sin descripción";
        const taskDeadline = task?.deadline || corTaskData?.deadline || "Sin fecha límite";
        const taskPriority = PRIORITY_LABELS[task?.priority ?? corTaskData?.priority ?? 1] || "Media";
        const taskStatus = task?.status || corTaskData?.status || "Sin estado";
        const corId = task?.corTaskId || args.corTaskId || "No sincronizada";
        
        return `📋 **Task actual${corId !== "No sincronizada" ? ` (COR ID: ${corId})` : ""}**

**Título:** ${taskTitle}
**Estado:** ${taskStatus}
**Prioridad:** ${taskPriority}
**Deadline:** ${taskDeadline}

**Descripción:**
${taskDesc}

¿Qué cambios quieres hacer?`;
      }
      
      console.log(`[EditTask] Campos a actualizar:`, JSON.stringify(updates, null, 2));
      
      // ====================================================
      // ACTUALIZAR EN CONVEX (si existe registro local)
      // ====================================================
      if (taskIdToEdit) {
        await ctx.runMutation(internal.data.tasks.updateTaskInternal, {
          taskId: taskIdToEdit,
          updates,
        });
        console.log(`[EditTask] ✅ Task ${taskIdToEdit} actualizada en Convex`);
      }
      
      // ====================================================
      // SINCRONIZAR CON COR (si la task está publicada)
      // ====================================================
      let corUpdateResult: any = null;
      const corIdToUpdate = args.corTaskId || task?.corTaskId;
      
      if (corIdToUpdate) {
        console.log(`[EditTask] 🔄 Task publicada en COR (ID: ${corIdToUpdate}) — sincronizando...`);
        
        try {
          const provider = getProjectManagementProvider();
          corUpdateResult = await provider.updateTask(parseInt(corIdToUpdate), {
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
      } else {
        console.log("[EditTask] ℹ️ Task solo en Convex (no publicada en COR)");
      }
      
      console.log("========================================\n");
      
      // ====================================================
      // CONSTRUIR RESPUESTA CON TASK COMPLETA ACTUALIZADA
      // ====================================================
      const updatedFields = Object.keys(updates).join(", ");
      
      // Leer la task actualizada para mostrarla completa
      let updatedTask = task;
      if (taskIdToEdit) {
        updatedTask = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToEdit });
      }
      
      const finalTitle = updatedTask?.title || args.title || task?.title || "Sin título";
      const finalDesc = updatedTask?.description || args.description || task?.description || "Sin descripción";
      const finalDeadline = updatedTask?.deadline || args.deadline || task?.deadline || "Sin fecha límite";
      const finalPriority = PRIORITY_LABELS[updatedTask?.priority ?? args.priority ?? task?.priority ?? 1] || "Media";
      
      let corStatus = "";
      if (corIdToUpdate) {
        if (corUpdateResult?.success) {
          corStatus = `\n✅ Cambios sincronizados en COR (ID: ${corIdToUpdate})`;
        } else if (corUpdateResult) {
          corStatus = `\n⚠️ No se pudieron sincronizar los cambios en COR: ${corUpdateResult.error}`;
        }
      }
      
      return `✅ Task actualizada exitosamente!

**Campos actualizados:** ${updatedFields}${corStatus}

📋 **Task actualizada:**
**Título:** ${finalTitle}
**Prioridad:** ${finalPriority}
**Deadline:** ${finalDeadline}

**Descripción:**
${finalDesc}

¿Hay algo más que quieras modificar?`;
    } catch (error) {
      console.error("[EditTask] Error actualizando task:", error);
      return `Error al actualizar la task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
