// convex/data/tasks.ts
// Funciones Convex para manejar tasks/requerimientos
// (mutations, queries, internalActions, publish flow, sync flow)
//
// NOTA: Los tools de agentes están en convex/tools/
import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "../_generated/server";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { getProjectManagementProvider } from "../integrations/registry";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashText } from "../lib/briefFormat";

// ==================== MUTATIONS ====================

// Mutation interna para crear task (llamada desde el tool o workflow)
export const createTaskInternal = internalMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    deadline: v.optional(v.string()),
    priority: v.optional(v.number()),       // 0=Low, 1=Medium, 2=High, 3=Urgent
    threadId: v.string(),
    status: v.string(),
    fileIds: v.optional(v.array(v.string())),
    createdBy: v.optional(v.string()),
    // Referencia al proyecto local
    projectId: v.optional(v.string()),
    // Campos para sincronización con COR
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.optional(v.string()),
    corSyncError: v.optional(v.string()),
    // Campos para identificar el cliente en el sistema externo
    corClientId: v.optional(v.number()),
    corClientName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Tasks.createTaskInternal] Insertando en base de datos...");
    
    const taskId = await ctx.db.insert("tasks", {
      title: args.title,
      description: args.description,
      deadline: args.deadline,
      priority: args.priority ?? 1,
      threadId: args.threadId,
      status: args.status,
      fileIds: args.fileIds,
      createdBy: args.createdBy,
      // Referencia al proyecto local
      projectId: args.projectId as any,
      // Campos COR / sistema externo
      corTaskId: args.corTaskId,
      corProjectId: args.corProjectId,
      corSyncStatus: args.corSyncStatus,
      corSyncError: args.corSyncError,
      corClientId: args.corClientId,
      corClientName: args.corClientName,
    });
    
    console.log(`[Tasks.createTaskInternal] Task insertada con ID: ${taskId}`);
    
    return taskId;
  },
});

// Mutation interna para actualizar task (llamada desde el editTaskTool)
export const updateTaskInternal = internalMutation({
  args: {
    taskId: v.string(),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priority: v.optional(v.number()),     // 0=Low, 1=Medium, 2=High, 3=Urgent
    }),
  },
  handler: async (ctx, args) => {
    console.log(`[Tasks.updateTaskInternal] Actualizando task ${args.taskId}...`);
    
    // Filtrar campos undefined
    const updateData: any = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }
    
    await ctx.db.patch(args.taskId as any, updateData);
    
    console.log(`[Tasks.updateTaskInternal] Task actualizada`);
    return args.taskId;
  },
});

// Query interna para obtener task por threadId
export const getTaskByThreadInternal = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    return task;
  },
});

// Query interna para obtener task por ID
export const getTaskByIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Buscar la task usando query en lugar de get para asegurar el tipo correcto
      const tasks = await ctx.db
        .query("tasks")
        .filter((q) => q.eq(q.field("_id"), args.taskId))
        .collect();
      return tasks[0] || null;
    } catch {
      return null;
    }
  },
});

// Query interna para obtener task por COR ID
export const getTaskByCORIdInternal = internalQuery({
  args: {
    corTaskId: v.string(),
  },
  handler: async (ctx, args) => {
    // Buscar la task que tenga este COR ID
    const task = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("corTaskId"), args.corTaskId))
      .first();
    return task;
  },
});

// Query interna para obtener el userId del thread
export const getUserIdFromThread = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    return chatThread?.userId || null;
  },
});

// Mutation pública para actualizar campos de una task desde el frontend (Panel de Control)
// Si la task está publicada en COR (synced), dispara sincronización automática.
export const updateTaskFields = mutation({
  args: {
    taskId: v.id("tasks"),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priority: v.optional(v.number()),     // 0=Low, 1=Medium, 2=High, 3=Urgent
      status: v.optional(v.string()),       // nueva, en_proceso, estancada, finalizada
    }),
  },
  handler: async (ctx, args) => {
    // Verificar que el usuario esté autenticado
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // Filtrar campos undefined
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    if (Object.keys(updateData).length === 0) return args.taskId;

    // Agregar timestamp de edición local
    updateData.lastLocalEditAt = Date.now();

    console.log(`[Tasks.updateTaskFields] Actualizando task ${args.taskId}:`, Object.keys(updateData));
    await ctx.db.patch(args.taskId, updateData as any);

    // Si la task está publicada en COR, disparar sincronización automática
    if (task.corSyncStatus === "synced" && task.corTaskId) {
      console.log(`[Tasks.updateTaskFields] 🔄 Task synced en COR — disparando sincronización`);
      
      // Determinar qué campos cambiaron para pasarlos a la action
      const changedFields = Object.keys(args.updates).filter(
        (k) => (args.updates as any)[k] !== undefined
      );

      await ctx.scheduler.runAfter(0, internal.data.tasks.syncEditToCORAction, {
        taskId: args.taskId,
        changedFields,
      });
    }

    return args.taskId;
  },
});

// Mutation para actualizar el estado de una task
export const updateTaskStatus = mutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId, {
      status: args.status,
    });
    return args.taskId;
  },
});

// Mutation para agregar fileIds a una task existente
export const addFilesToTask = mutation({
  args: {
    taskId: v.id("tasks"),
    fileIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");
    
    const currentFileIds = task.fileIds || [];
    const newFileIds = [...currentFileIds, ...args.fileIds];
    
    await ctx.db.patch(args.taskId, {
      fileIds: newFileIds,
    });
    return args.taskId;
  },
});

// ==================== BACKGROUND JOB: Asociar archivos a task ====================
// Esta acción se ejecuta en background después de crear una task
// para buscar y asociar los archivos del thread sin bloquear la respuesta
// TAMBIÉN envía los archivos a COR como attachments si la task está sincronizada
export const associateFilesToTask = internalAction({
  args: {
    taskId: v.string(),
    threadId: v.string(),
    corTaskId: v.optional(v.number()), // ID de la task en COR para enviar attachments
  },
  handler: async (ctx, args): Promise<void> => {
    console.log(`[AssociateFiles] Buscando archivos para task ${args.taskId}...`);
    
    try {
      // Obtener todos los mensajes del thread
      const messagesResult = await listMessages(ctx, components.agent, {
        threadId: args.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      });
      
      const allFileIds: string[] = [];
      
      // Buscar fileIds en cada mensaje
      for (const msg of messagesResult.page) {
        const msgAny = msg as any;
        
        // Verificar si el mensaje tiene fileIds (guardados como metadata)
        if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
          console.log(`[AssociateFiles] FileIds encontrados: ${msgAny.fileIds}`);
          allFileIds.push(...msgAny.fileIds);
        }
      }
      
      if (allFileIds.length > 0) {
        console.log(`[AssociateFiles] Asociando ${allFileIds.length} archivos a task ${args.taskId}`);
        
        // Actualizar la task con los fileIds encontrados
        await ctx.runMutation(internal.data.tasks.updateTaskFileIds, {
          taskId: args.taskId,
          fileIds: allFileIds,
        });
        
        console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente a task local`);
        
        // Si la task está sincronizada con COR, enviar los archivos como mensaje con attachments
        if (args.corTaskId) {
          console.log(`[AssociateFiles] 📎 Enviando archivos a COR (Task ID: ${args.corTaskId})...`);
          
          try {
            // Obtener información y URLs de cada archivo
            const attachments: { name: string; url: string; type: string; source: string }[] = [];
            
            for (const fileId of allFileIds) {
              try {
                // Obtener info del archivo desde el agente
                const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
                
                if (fileInfo && fileInfo.url) {
                  attachments.push({
                    name: fileInfo.filename || `archivo_${fileId}`,
                    url: fileInfo.url,
                    type: fileInfo.mimeType || "application/octet-stream",
                    source: "convex",
                  });
                  console.log(`[AssociateFiles] 📎 Archivo preparado: ${fileInfo.filename}`);
                }
              } catch (fileError) {
                console.error(`[AssociateFiles] ⚠️ Error obteniendo archivo ${fileId}:`, fileError);
              }
            }
            
            // Si hay attachments, enviar mensaje al sistema externo
            if (attachments.length > 0) {
              const provider = getProjectManagementProvider();
              await provider.postTaskMessage({
                taskId: args.corTaskId,
                message: `📎 Archivos adjuntos del brief (${attachments.length} archivo${attachments.length > 1 ? 's' : ''})`,
                attachments,
              });
              console.log(`[AssociateFiles] ✅ ${attachments.length} archivos enviados a COR`);
            }
          } catch (corError) {
            console.error(`[AssociateFiles] ⚠️ Error enviando archivos a COR:`, corError);
            // No fallar si COR tiene problemas, los archivos ya están asociados localmente
          }
        }
      } else {
        console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
      }
    } catch (error) {
      console.error(`[AssociateFiles] Error:`, error);
    }
  },
});

// Query interna para obtener información de un archivo
export const getFileInfoInternal = internalQuery({
  args: {
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Obtener el documento file del componente agent
      const fileDoc = await ctx.runQuery(
        components.agent.files.get,
        { fileId: args.fileId }
      );
      
      if (!fileDoc) {
        console.error(`[Files] No se encontró el archivo con fileId: ${args.fileId}`);
        return null;
      }
      
      // Obtener la URL desde el storageId
      const url = await ctx.storage.getUrl(fileDoc.storageId);
      
      return {
        fileId: args.fileId,
        filename: fileDoc.filename || `archivo_${args.fileId}`,
        mimeType: fileDoc.mimeType,
        url,
      };
    } catch (error) {
      console.error(`[Files] Error obteniendo info para fileId ${args.fileId}:`, error);
      return null;
    }
  },
});

// Mutation interna para actualizar fileIds de una task
export const updateTaskFileIds = internalMutation({
  args: {
    taskId: v.string(),
    fileIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId as any, {
      fileIds: args.fileIds,
    });
    return args.taskId;
  },
});

// ==================== QUERIES ====================

// Obtener task por threadId
export const getTaskByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    
    return task;
  },
});

// Obtener una task por ID
export const getTask = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.taskId);
  },
});

// Listar todas las tasks
export const listTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    }
    return await ctx.db.query("tasks").collect();
  },
});

// Listar tasks por threadId
export const listByThread = query({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
  },
});

// ==================== QUERY: LISTAR TASKS DEL USUARIO AUTENTICADO ====================

/**
 * Lista las tasks creadas por el usuario autenticado.
 * Se usa en el Panel de Control para mostrar las tasks del usuario.
 * Soporta filtro opcional por status.
 * Retorna ordenadas por fecha de creación descendente (más recientes primero).
 */
export const listMyTasks = query({
  args: {
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Obtener el userId autenticado via @convex-dev/auth
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const userIdStr = String(userId);
    
    // Buscar tasks creadas por este usuario
    let tasks = await ctx.db
      .query("tasks")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", userIdStr))
      .order("desc")
      .collect();
    
    // Filtrar por status si se proporcionó
    if (args.status) {
      tasks = tasks.filter((t) => t.status === args.status);
    }
    
    return tasks;
  },
});

// ==================== SYNC: CONVEX → COR (mapeo 1:1) ====================

/**
 * Campos de Convex que tienen equivalente directo en COR.
 * Estos se sincronizan 1:1 sin transformación.
 *
 *   Convex field  →  COR field
 *   title         →  title
 *   description   →  description
 *   deadline      →  deadline
 *   priority      →  priority
 *   status        →  status
 */
const COR_SYNCABLE_FIELDS = new Set(["title", "description", "deadline", "priority", "status"]);

/**
 * Action interna: sincroniza una edición local de Convex hacia COR.
 * 
 * SEGURIDAD CRÍTICA:
 * - Lee el corTaskId y corProjectId directamente de la task de Convex
 * - Verifica que la task siga en estado "synced" antes de tocar COR
 * - Solo edita la task COR que corresponde al corTaskId guardado
 * - Verifica que la task en COR pertenece al proyecto correcto (corProjectId)
 * - Logea exhaustivamente cada operación para auditoría
 * 
 * Flujo:
 * 1. Lee la task actualizada de Convex
 * 2. Si cambiaron campos nativos (title, deadline, priority) → updateTask directo
 * 3. Si cambiaron campos de descripción → regenera con buildCORDescription
 * 4. Actualiza hash y timestamps
 */
export const syncEditToCORAction = internalAction({
  args: {
    taskId: v.id("tasks"),
    changedFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("\n========================================");
    console.log("[SyncEdit] 🔄 SINCRONIZANDO EDICIÓN LOCAL → COR");
    console.log(`[SyncEdit] Task Convex ID: ${args.taskId}`);
    console.log(`[SyncEdit] Campos cambiados: ${args.changedFields.join(", ")}`);
    console.log("========================================\n");

    try {
      // 1. Leer la task actualizada de Convex
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[SyncEdit] ❌ Task no encontrada en Convex");
        return;
      }

      // ═══════════════════════════════════════════════════
      // VERIFICACIONES DE SEGURIDAD — NUNCA SALTEAR
      // ═══════════════════════════════════════════════════

      // Verificar que la task sigue synced
      if (task.corSyncStatus !== "synced") {
        console.error(`[SyncEdit] ❌ Task no está synced (estado: ${task.corSyncStatus}). Abortando.`);
        return;
      }

      // Verificar que tiene corTaskId
      const corTaskId = task.corTaskId;
      if (!corTaskId) {
        console.error("[SyncEdit] ❌ Task no tiene corTaskId. Abortando.");
        return;
      }

      // Verificar que tiene corProjectId
      const corProjectId = task.corProjectId;
      if (!corProjectId) {
        console.error("[SyncEdit] ❌ Task no tiene corProjectId. Abortando.");
        return;
      }

      // Verificar que tiene corClientId
      if (!task.corClientId) {
        console.error("[SyncEdit] ❌ Task no tiene corClientId. Abortando.");
        return;
      }

      console.log(`[SyncEdit] ✅ Verificaciones de seguridad OK:`);
      console.log(`  - corTaskId: ${corTaskId}`);
      console.log(`  - corProjectId: ${corProjectId}`);
      console.log(`  - corClientId: ${task.corClientId}`);
      console.log(`  - corClientName: ${task.corClientName}`);

      // 2. Obtener el provider
      const provider = getProjectManagementProvider();

      // 3. Primero, obtener la task actual de COR para verificación cruzada
      const corTask = await provider.getTask(parseInt(corTaskId));
      if (!corTask) {
        console.error(`[SyncEdit] ❌ Task COR ${corTaskId} no encontrada. ¿Fue eliminada?`);
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: `Task COR ${corTaskId} no encontrada — puede haber sido eliminada`,
        });
        return;
      }

      // VERIFICACIÓN CRUZADA: la task de COR debe pertenecer al proyecto correcto
      if (corTask.projectId !== corProjectId) {
        console.error(`[SyncEdit] 🚨 ALERTA DE SEGURIDAD: La task COR ${corTaskId} pertenece al proyecto ${corTask.projectId}, no al esperado ${corProjectId}. ABORTANDO.`);
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: `Error de seguridad: task COR pertenece a proyecto incorrecto`,
        });
        return;
      }

      console.log(`[SyncEdit] ✅ Verificación cruzada OK — task COR ${corTaskId} pertenece al proyecto ${corProjectId}`);

      // ═══════════════════════════════════════════════════
      // CONSTRUIR EL UPDATE (mapeo 1:1)
      // ═══════════════════════════════════════════════════

      const updatePayload: Record<string, unknown> = {};

      // Solo sincronizar campos que tienen equivalente en COR
      const syncableChanges = args.changedFields.filter((f) => COR_SYNCABLE_FIELDS.has(f));

      if (syncableChanges.length === 0) {
        console.log("[SyncEdit] ℹ️ No hay campos sincronizables con COR (cambios son solo locales)");
        return;
      }

      console.log(`[SyncEdit] 📝 Campos a sincronizar: ${syncableChanges.join(", ")}`);

      // Mapeo directo 1:1
      if (syncableChanges.includes("title")) updatePayload.title = task.title;
      if (syncableChanges.includes("description")) updatePayload.description = task.description || "";
      if (syncableChanges.includes("deadline")) updatePayload.deadline = task.deadline;
      if (syncableChanges.includes("priority")) updatePayload.priority = task.priority;
      if (syncableChanges.includes("status")) updatePayload.status = task.status;

      // 4. Actualizar la task en COR
      console.log(`[SyncEdit] 🚀 Enviando actualización a COR task ${corTaskId}:`, Object.keys(updatePayload));
      
      const result = await provider.updateTask(parseInt(corTaskId), updatePayload as any);

      if (!result.success) {
        console.error(`[SyncEdit] ❌ Error actualizando COR: ${result.error}`);
        // No marcamos como error global, solo logeamos — la edición local ya se guardó
        return;
      }

      // 5. Actualizar hash y timestamp de sync
      if (updatePayload.description) {
        const newHash = hashText(updatePayload.description as string);
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corDescriptionHash: newHash,
          corSyncedAt: Date.now(),
        });
        console.log(`[SyncEdit] ✅ Hash actualizado: ${newHash}`);
      } else {
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncedAt: Date.now(),
        });
      }

      console.log(`[SyncEdit] ✅ Sincronización completada exitosamente`);
      console.log("========================================\n");

    } catch (error) {
      console.error("[SyncEdit] ❌ Error en sincronización:", error);
      // No marcamos la task como error — la edición local ya está guardada
      // El cron futuro podrá detectar la discrepancia y corregirla
    }
  },
});

/**
 * Mutation interna para actualizar metadata de sync sin tocar otros campos.
 */
export const updateSyncMetadata = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corDescriptionHash: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    lastLocalEditAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {};
    if (args.corDescriptionHash !== undefined) updateData.corDescriptionHash = args.corDescriptionHash;
    if (args.corSyncedAt !== undefined) updateData.corSyncedAt = args.corSyncedAt;
    if (args.lastLocalEditAt !== undefined) updateData.lastLocalEditAt = args.lastLocalEditAt;
    
    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(args.taskId, updateData as any);
    }
  },
});

// ==================== PUBLICAR TASK EN SISTEMA EXTERNO (COR) ====================

/**
 * Mutation pública que inicia la publicación de una task en el sistema externo.
 * 
 * Patrón: mutation (feedback inmediato) → scheduler.runAfter(0, action) (trabajo async)
 * 
 * 1. Valida que la task existe y pertenece al usuario
 * 2. Pone corSyncStatus: "syncing" (feedback inmediato para la UI)
 * 3. Schedula la action que hace el trabajo pesado (crear proyecto + task en COR)
 * 4. Retorna inmediatamente — la UI se actualiza reactivamente via subscriptions
 */
export const startPublishTaskToExternal = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    // Verificar autenticación
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("No autenticado");
    }

    // Obtener la task
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      throw new Error("Task no encontrada");
    }

    // Verificar que la task no está ya sincronizada
    if (task.corSyncStatus === "synced") {
      throw new Error("La task ya está publicada en el sistema externo");
    }

    // Verificar que no está en proceso de sincronización
    if (task.corSyncStatus === "syncing") {
      throw new Error("La task ya está en proceso de publicación");
    }

    // Poner estado "syncing" — la UI lo verá inmediatamente
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncError: undefined,
    });

    // Schedular la action que hace el trabajo pesado
    // runAfter(0, ...) = ejecutar inmediatamente en background
    await ctx.scheduler.runAfter(0, internal.data.tasks.publishTaskToExternalAction, {
      taskId: args.taskId,
    });

    return { success: true, message: "Publicación iniciada" };
  },
});

/**
 * Action interna que ejecuta la publicación real en el sistema externo.
 * Se ejecuta en background via scheduler para no bloquear al usuario.
 * 
 * Flujo:
 * 1. Lee la task de Convex
 * 2. Crea un PROYECTO en COR (POST /projects) asociado al client_id
 * 3. Crea una TASK en COR (POST /tasks) dentro del proyecto
 * 4. Actualiza la task local con los IDs externos y estado "synced"
 * 5. Asocia los archivos del thread a la task en COR
 */
export const publishTaskToExternalAction = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    console.log("\n========================================");
    console.log("[PublishTask] 🚀 PUBLICANDO TASK EN SISTEMA EXTERNO");
    console.log(`[PublishTask] Task ID: ${args.taskId}`);
    console.log("========================================\n");

    try {
      // 1. Leer la task de Convex
      const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
        taskId: args.taskId as string,
      });

      if (!task) {
        console.error("[PublishTask] ❌ Task no encontrada");
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: "Task no encontrada en la base de datos",
        });
        return;
      }

      // 2. Obtener el provider de integraciones
      const provider = getProjectManagementProvider();
      console.log(`[PublishTask] Provider: ${provider.name}`);

      // 3. Crear PROYECTO en el sistema externo (o reusar si ya fue publicado)
      const clientId = task.corClientId;
      if (!clientId) {
        console.error("[PublishTask] ❌ No hay corClientId — no se puede crear proyecto");
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: "No se encontró un cliente asociado. Busca el cliente antes de publicar.",
        });
        return;
      }

      // Verificar si existe un proyecto local en la tabla projects
      let corProjectId: number | undefined;
      const projectId = (task as any).projectId as string | undefined;

      if (projectId) {
        // Leer el proyecto local
        const localProject = await ctx.runQuery(internal.data.projects.getProjectInternal, {
          projectId: projectId as any,
        });

        if (localProject?.corProjectId) {
          // El proyecto ya fue publicado en COR — reutilizar
          corProjectId = localProject.corProjectId;
          console.log(`[PublishTask] ℹ️ Reutilizando proyecto COR existente: ${corProjectId}`);
        } else {
          // Crear el proyecto en COR
          console.log(`[PublishTask] 📁 Creando proyecto en COR para cliente ID: ${clientId}...`);
          const projectName = localProject?.name || `${task.corClientName || "Sin cliente"} - ${task.title}`;

          const project = await provider.createProject({
            name: projectName,
            clientId,
            description: localProject?.brief || task.description,
            deadline: localProject?.endDate || task.deadline,
          });

          corProjectId = project.id;
          console.log(`[PublishTask] ✅ Proyecto creado en COR: ID ${corProjectId}`);

          // Actualizar el proyecto local con el corProjectId
          await ctx.runMutation(internal.data.projects.updateProjectPublishStatus, {
            projectId: projectId as any,
            corProjectId: project.id,
            corSyncStatus: "synced",
          });
        }
      } else {
        // Fallback: no hay proyecto local, crear directamente en COR (backward compat)
        console.log(`[PublishTask] 📁 Creando proyecto en COR (sin proyecto local) para cliente ID: ${clientId}...`);
        const projectName = `${task.corClientName || "Sin cliente"} - ${task.title}`;

        const project = await provider.createProject({
          name: projectName,
          clientId,
          description: task.description,
          deadline: task.deadline,
        });

        corProjectId = project.id;
        console.log(`[PublishTask] ✅ Proyecto creado en COR: ID ${corProjectId}`);
      }

      console.log(`[PublishTask] ✅ Proyecto listo: corProjectId=${corProjectId}`);

      // 4. Crear TASK dentro del proyecto
      // Mapeo 1:1: cada campo de Convex va a su campo equivalente en COR
      // description → description, deadline → deadline, priority → priority
      console.log(`[PublishTask] 📋 Creando task en proyecto ${corProjectId}...`);

      const externalTask = await provider.createTask({
        projectId: corProjectId!,
        title: task.title,
        description: task.description || "",
        deadline: task.deadline,
        priority: task.priority,
      });

      console.log(`[PublishTask] ✅ Task creada: ID ${externalTask.id}`);

      // 5. Actualizar task local con IDs externos y estado "synced"
      const descriptionHash = hashText(task.description || "");
      
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "synced",
        corTaskId: String(externalTask.id),
        corProjectId: corProjectId,
        corSyncedAt: Date.now(),
        corDescriptionHash: descriptionHash,
      });

      console.log(`[PublishTask] ✅ IDs guardados — corTaskId: ${externalTask.id}, corProjectId: ${corProjectId}, clientId: ${clientId}, hash: ${descriptionHash}`);

      // 6. Asociar archivos si existen
      if (task.fileIds && task.fileIds.length > 0) {
        console.log(`[PublishTask] 📎 Enviando ${task.fileIds.length} archivos a COR...`);
        try {
          // Preparar attachments
          const attachments: { name: string; url: string; type: string; source: string }[] = [];
          
          for (const fileId of task.fileIds) {
            try {
              const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
              if (fileInfo && fileInfo.url) {
                attachments.push({
                  name: fileInfo.filename || `archivo_${fileId}`,
                  url: fileInfo.url,
                  type: fileInfo.mimeType || "application/octet-stream",
                  source: "convex",
                });
              }
            } catch (fileError) {
              console.error(`[PublishTask] ⚠️ Error obteniendo archivo ${fileId}:`, fileError);
            }
          }
          
          if (attachments.length > 0) {
            await provider.postTaskMessage({
              taskId: externalTask.id,
              message: `📎 Archivos adjuntos del brief (${attachments.length} archivo${attachments.length > 1 ? 's' : ''})`,
              attachments,
            });
            console.log(`[PublishTask] ✅ ${attachments.length} archivos enviados`);
          }
        } catch (fileError) {
          console.error("[PublishTask] ⚠️ Error enviando archivos (task ya publicada):", fileError);
        }
      }

      console.log("\n========================================");
      console.log("[PublishTask] 🏁 PUBLICACIÓN COMPLETADA");
      console.log(`[PublishTask] Proyecto: ${corProjectId}`);
      console.log(`[PublishTask] Task COR: ${externalTask.id}`);
      console.log("========================================\n");

    } catch (error) {
      console.error("[PublishTask] ❌ Error publicando:", error);
      
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
        taskId: args.taskId,
        corSyncStatus: "error",
        corSyncError: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/**
 * Mutation interna para actualizar el estado de publicación.
 * Llamada desde publishTaskToExternalAction para actualizar
 * la task con el resultado (éxito o error).
 */
export const updatePublishStatus = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corSyncStatus: v.string(),
    corSyncError: v.optional(v.string()),
    corTaskId: v.optional(v.string()),
    corProjectId: v.optional(v.number()),
    corSyncedAt: v.optional(v.number()),
    corDescriptionHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {
      corSyncStatus: args.corSyncStatus,
    };
    
    if (args.corSyncError !== undefined) updateData.corSyncError = args.corSyncError;
    if (args.corTaskId !== undefined) updateData.corTaskId = args.corTaskId;
    if (args.corProjectId !== undefined) updateData.corProjectId = args.corProjectId;
    if (args.corSyncedAt !== undefined) updateData.corSyncedAt = args.corSyncedAt;
    if (args.corDescriptionHash !== undefined) updateData.corDescriptionHash = args.corDescriptionHash;
    
    await ctx.db.patch(args.taskId, updateData as any);
    console.log(`[UpdatePublishStatus] Task ${args.taskId} → ${args.corSyncStatus}`);
  },
});

/**
 * Mutation interna para actualizar el estado de sincronización con el sistema externo.
 * Equivalente a la anterior updateCORSyncStatus de cor.ts, pero como mutation en tasks.ts.
 */
export const updateCORSyncStatus = internalMutation({
  args: {
    taskId: v.string(),
    corTaskId: v.optional(v.number()),
    syncStatus: v.string(), // "pending" | "synced" | "error"
    syncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(`[Tasks] Actualizando sync status de task ${args.taskId} a ${args.syncStatus}`);
    
    await ctx.db.patch(args.taskId as any, {
      corTaskId: args.corTaskId ? String(args.corTaskId) : undefined,
      corSyncStatus: args.syncStatus,
      corSyncError: args.syncError,
    });
    
    return args.taskId;
  },
});

/**
 * Actualiza el timestamp de sincronización con COR.
 * Migrado desde workflows/taskCreation.ts.
 */
export const updateCORSyncTimestamp = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskId as any, {
      corSyncedAt: Date.now(),
    });
  },
});
