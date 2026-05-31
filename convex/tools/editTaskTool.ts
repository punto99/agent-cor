// convex/tools/editTaskTool.ts
// Tool para editar una task existente en Convex y sincronizar con COR si está publicada.
// Usa scheduleTaskSyncToCOR para unificar el flujo de sync con la UI.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
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
  Debes declarar en fieldsToEdit EXACTAMENTE los campos que el usuario pidio cambiar.
  Si el usuario solo pidio cambiar el titulo, fieldsToEdit debe ser ["title"] y NO debes enviar description.
  IMPORTANTE: El backend solo aplicara los campos declarados en fieldsToEdit. Cualquier otro campo enviado por error sera ignorado.
  La descripcion contiene toda la info del brief (tipo, marca, objetivo, kpis, etc.).
  Si el usuario quiere cambiar algo de la descripcion, primero usa getTask para ver el contenido actual,
  luego envia la descripcion completa preservando todo lo que no se pidio cambiar.
  
  Si la task está publicada en COR, los cambios se sincronizarán automáticamente.`,
  args: z.object({
    corTaskId: z.string().optional().describe("ID de la task en COR (ej: 11301144) - PREFERIDO"),
    taskId: z.string().optional().describe("ID local de la task (opcional si se usa corTaskId o thread)"),
    fieldsToEdit: z.array(z.enum(["title", "description", "deadline", "priority"]))
      .min(1)
      .describe("Campos que el usuario pidio editar explicitamente. Debe coincidir EXACTAMENTE con los campos enviados."),
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
        task = await ctx.runQuery(internal.data.tasks.getTaskByCORIdInternal, { 
          corTaskId: args.corTaskId 
        });
        
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] 📋 Task local encontrada: ${taskIdToEdit}`);
        } else {
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
      } 
      // PRIORIDAD 3: Buscar por threadId
      else if (threadId) {
        console.log(`[EditTask] Buscando task por threadId: ${threadId}`);
        task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task) {
          taskIdToEdit = task._id;
          console.log(`[EditTask] Task encontrada: ${taskIdToEdit}`);
        }
      }
      
      // Si no encontramos ninguna task
      if (!task || !taskIdToEdit) {
        return "Error: No se pudo identificar la task a editar. Por favor proporciona el COR ID de la task (ej: 11301144), el ID local, o asegurate de estar en la conversacion correcta.";
      }
      
      // ====================================================
      // VALIDACIÓN DE PERMISOS (clientUserAssignments)
      // ====================================================
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
            return `No tienes permisos para editar tasks del cliente "${task.corClientName || "desconocido"}".`;
          }
        }
      }
      
      // ====================================================
      // CONSTRUIR CAMPOS A ACTUALIZAR
      // ====================================================
      const requestedFields = Array.from(new Set(args.fieldsToEdit));

      const updates: Record<string, string | number | undefined> = {};
      const missingFields: string[] = [];

      for (const field of requestedFields) {
        if (field === "title") {
          if (typeof args.title === "string" && args.title.trim()) {
            updates.title = args.title.trim();
          } else {
            missingFields.push("title");
          }
        }

        if (field === "description") {
          if (typeof args.description === "string" && args.description.trim()) {
            updates.description = args.description;
          } else {
            missingFields.push("description");
          }
        }

        if (field === "deadline") {
          if (typeof args.deadline === "string" && args.deadline.trim()) {
            updates.deadline = args.deadline.trim();
          } else {
            missingFields.push("deadline");
          }
        }

        if (field === "priority") {
          if (typeof args.priority === "number") {
            updates.priority = args.priority;
          } else {
            missingFields.push("priority");
          }
        }
      }

      const updateKeys = Object.keys(updates);

      const ignoredFields = ["title", "description", "deadline", "priority"]
        .filter((field) => !requestedFields.includes(field as any))
        .filter((field) => (args as any)[field] !== undefined);
      if (ignoredFields.length > 0) {
        console.log(
          `[EditTask] Campos ignorados por no estar en fieldsToEdit: ${ignoredFields.join(", ")}`
        );
      }

      if (missingFields.length > 0) {
        return `No se aplicó ningún cambio porque faltan valores válidos para: ${missingFields.join(", ")}.`;
      }

      if (updateKeys.length === 0) {
        // Si no hay campos para actualizar, mostrar la task actual
        const taskPriority = PRIORITY_LABELS[task.priority ?? 1] || "Media";
        const corId = task.corTaskId || "No sincronizada";
        
        return `📋 **Task actual${corId !== "No sincronizada" ? ` (COR ID: ${corId})` : ""}**

**Título:** ${task.title || "Sin título"}
**Estado:** ${task.status || "Sin estado"}
**Prioridad:** ${taskPriority}
**Deadline:** ${task.deadline || "Sin fecha límite"}

**Descripción:**
${task.description || "Sin descripción"}

¿Qué cambios quieres hacer?`;
      }
      
      console.log(`[EditTask] Campos a actualizar:`, JSON.stringify(updates, null, 2));
      
      // ====================================================
      // ACTUALIZAR EN CONVEX
      // ====================================================
      await ctx.runMutation(internal.data.tasks.updateTaskInternal, {
        taskId: taskIdToEdit,
        updates,
        allowedFields: requestedFields,
      });
      console.log(`[EditTask] ✅ Task ${taskIdToEdit} actualizada en Convex`);
      
      // ====================================================
      // PROGRAMAR SYNC A COR (flujo unificado)
      // ====================================================
      const changedFields = Object.keys(updates);
      await ctx.runMutation(internal.data.tasks.scheduleTaskSyncToCOR, {
        taskId: taskIdToEdit as any,
        changedFields,
      });
      
      console.log("========================================\n");
      
      // ====================================================
      // CONSTRUIR RESPUESTA CON TASK COMPLETA ACTUALIZADA
      // ====================================================
      const updatedFields = changedFields.join(", ");
      const updatedTask = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, { taskId: taskIdToEdit });
      
      const finalTitle = updatedTask?.title || task.title || "Sin título";
      const finalDesc = updatedTask?.description || task.description || "Sin descripción";
      const finalDeadline = updatedTask?.deadline || task.deadline || "Sin fecha límite";
      const finalPriority = PRIORITY_LABELS[updatedTask?.priority ?? task.priority ?? 1] || "Media";
      
      const corId = task.corTaskId;
      const corStatus = corId
        ? `\n🔄 Sincronización con COR (ID: ${corId}) programada automáticamente.`
        : "";
      
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
