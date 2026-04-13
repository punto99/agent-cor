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
import { shouldRetry, getRetryDelay, formatRetryError, isClientError, MAX_RETRY_ATTEMPTS } from "../lib/corRetry";
import type { ActionCtx } from "../_generated/server";

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
    
    // Registrar timestamp de edición local (detección de conflictos bidireccional)
    updateData.lastLocalEditAt = Date.now();
    
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

    // ─── Bloquear edición durante sincronización ───
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La tarea se está sincronizando con el sistema externo. Espera a que termine la sincronización antes de editar."
      );
    }

    // ─── Validación de permisos (clientUserAssignments) ───
    if (task.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .filter((q) => q.eq(q.field("corClientId"), task.corClientId))
        .first();

      if (client) {
        const user = await ctx.db
          .query("users")
          .filter((q) => q.eq(q.field("_id"), userId))
          .first();

        if (user) {
          const assignment = await ctx.db
            .query("clientUserAssignments")
            .withIndex("by_client_and_user", (q) =>
              q.eq("clientId", client._id).eq("userId", user._id)
            )
            .first();

          if (!assignment) {
            throw new Error(
              `No tienes permisos para editar tasks del cliente "${task.corClientName || client.name}".`
            );
          }
        }
      }
    }

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

    // Programar sync a COR si corresponde (via internalMutation)
    const changedFields = Object.keys(args.updates).filter(
      (k) => (args.updates as any)[k] !== undefined
    );
    await ctx.scheduler.runAfter(0, internal.data.tasks.scheduleTaskSyncToCOR, {
      taskId: args.taskId,
      changedFields,
    });

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



// ==================== BACKGROUND JOB: Asociar archivos a task ====================
// Esta acción se ejecuta en background después de crear una task
// para buscar archivos del thread y crear registros en taskAttachments
export const associateFilesToTask = internalAction({
  args: {
    taskId: v.string(),
    threadId: v.string(),
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
        if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
          allFileIds.push(...msgAny.fileIds);
        }
      }
      
      if (allFileIds.length === 0) {
        console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
        return;
      }

      console.log(`[AssociateFiles] Creando ${allFileIds.length} registros en taskAttachments...`);
      
      for (const fileId of allFileIds) {
        try {
          const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
          if (fileInfo) {
            await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
              taskId: args.taskId as any,
              fileId,
              storageId: fileInfo.storageId,
              filename: fileInfo.filename,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
            });
            console.log(`[AssociateFiles] ✅ Attachment creado: ${fileInfo.filename}`);
          }
        } catch (fileError) {
          console.error(`[AssociateFiles] ⚠️ Error con archivo ${fileId}:`, fileError);
        }
      }
      
      console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente`);
    } catch (error) {
      console.error(`[AssociateFiles] Error:`, error);
    }
  },
});

// Mutation interna para crear un registro de attachment
export const createTaskAttachment = internalMutation({
  args: {
    taskId: v.id("tasks"),
    fileId: v.string(),
    storageId: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("taskAttachments", {
      taskId: args.taskId,
      fileId: args.fileId,
      storageId: args.storageId,
      filename: args.filename,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: Date.now(),
    });
  },
});

// Mutation interna para marcar un attachment como sincronizado con COR
export const updateAttachmentCORSync = internalMutation({
  args: {
    attachmentId: v.id("taskAttachments"),
    corAttachmentId: v.number(),
    corUrl: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attachmentId, {
      corAttachmentId: args.corAttachmentId,
      corUrl: args.corUrl,
    });
  },
});

// Query interna para obtener attachments pendientes de sync (sin corAttachmentId)
export const getPendingAttachments = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const attachments = await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    return attachments.filter((a) => !a.corAttachmentId);
  },
});

// Query interna para obtener todos los attachments de una task
export const getTaskAttachments = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

// Query pública para que la UI pueda mostrar los attachments
export const getTaskAttachmentsPublic = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const attachments = await ctx.db
      .query("taskAttachments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    // Resolver URLs para cada attachment
    const results = [];
    for (const att of attachments) {
      const url = await ctx.storage.getUrl(att.storageId as any);
      results.push({
        _id: att._id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        url,
        corAttachmentId: att.corAttachmentId,
        createdAt: att.createdAt,
      });
    }
    return results;
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
        storageId: fileDoc.storageId,
        filename: fileDoc.filename || `archivo_${args.fileId}`,
        mimeType: fileDoc.mimeType || "application/octet-stream",
        size: (fileDoc as any).size as number | undefined,
        url,
      };
    } catch (error) {
      console.error(`[Files] Error obteniendo info para fileId ${args.fileId}:`, error);
      return null;
    }
  },
});


// ==================== CONSOLIDATED FUNCTIONS ====================
// Optimización: Reducir múltiples runQuery/runMutation a menos transacciones.
// Ref: https://docs.convex.dev/functions/actions#avoid-await-ctxrunmutation--await-ctxrunquery

/**
 * Validación consolidada para createTaskTool.
 * Una sola transacción que:
 * 1. Obtiene userId del thread
 * 2. Verifica idempotencia (no crear task duplicada)
 * 3. Verifica corUser (si integración habilitada)
 * 4. Verifica cliente local y autorización
 * 5. Verifica proyecto existente
 * 6. Resuelve localClientId y pmId
 */
export const validateAndPrepareTask = internalQuery({
  args: {
    threadId: v.string(),
    corClientId: v.optional(v.number()),
    corUserId: v.optional(v.number()),
    requireIntegration: v.boolean(),
  },
  handler: async (ctx, args) => {
    // 1. userId del thread
    const chatThread = await ctx.db
      .query("chatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();
    const userId = chatThread?.userId || null;

    // 2. Idempotencia — ¿ya existe task para este thread?
    const existingTask = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .first();

    if (existingTask) {
      return {
        ok: false as const,
        error: `Ya existe un requerimiento para esta conversación.\n\nID del requerimiento: ${existingTask._id}\nEstado: ${existingTask.status}\n\nSi necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.\nSi quieres modificar el existente, usa la herramienta "editTask".`,
      };
    }

    // 3-4. Validaciones de integración (si está habilitada)
    let localClientId: string | undefined;
    let pmId: number | undefined = args.corUserId;

    if (args.requireIntegration) {
      if (!userId) {
        return { ok: false as const, error: "❌ No se pudo identificar al usuario de esta conversación." };
      }

      // corUser
      const corUser = await ctx.db
        .query("corUsers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      if (!corUser) {
        return { ok: false as const, error: "❌ Tu usuario no está registrado en el sistema de gestión de proyectos (COR). Usa primero la herramienta 'validateUserForClient'." };
      }
      if (!pmId) pmId = corUser.corUserId;

      // cliente local
      if (args.corClientId) {
        const localClient = await ctx.db
          .query("corClients")
          .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
          .unique();
        if (!localClient) {
          return { ok: false as const, error: "❌ El cliente no está registrado localmente. Usa primero la herramienta 'validateUserForClient'." };
        }
        localClientId = localClient._id;

        // autorización
        const assignment = await ctx.db
          .query("clientUserAssignments")
          .withIndex("by_client_and_user", (q) =>
            q.eq("clientId", localClient._id).eq("userId", userId)
          )
          .unique();
        if (!assignment) {
          return { ok: false as const, error: `❌ No tienes autorización para crear briefs para este cliente. Contacta al administrador.` };
        }
      }
    } else {
      // Sin integración, resolver pmId si posible
      if (!pmId && userId) {
        const corUser = await ctx.db
          .query("corUsers")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique();
        if (corUser) pmId = corUser.corUserId;
      }
    }

    // 5. Proyecto existente para este thread
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();

    // Si no hay integración y no resolvimos localClientId, intentar buscar
    if (!localClientId && args.corClientId) {
      const localClient = await ctx.db
        .query("corClients")
        .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
        .unique();
      if (localClient) localClientId = localClient._id;
    }

    return {
      ok: true as const,
      userId: userId ? String(userId) : undefined,
      localClientId,
      pmId,
      existingProjectId: existingProject?._id || undefined,
    };
  },
});

/**
 * Crea proyecto + task atómicamente en una sola mutation.
 * Reemplaza createProjectInternal + createTaskInternal como calls separados.
 */
export const createProjectAndTask = internalMutation({
  args: {
    // Project fields
    projectName: v.string(),
    projectBrief: v.optional(v.string()),
    projectEndDate: v.optional(v.string()),
    projectDeliverables: v.optional(v.string()),
    projectEstimatedTime: v.optional(v.number()),
    projectPmId: v.optional(v.number()),
    projectCorClientId: v.optional(v.number()),
    projectClientId: v.optional(v.id("corClients")),
    projectCreatedBy: v.optional(v.string()),
    // Task fields
    taskTitle: v.string(),
    taskDescription: v.optional(v.string()),
    taskDeadline: v.optional(v.string()),
    taskPriority: v.optional(v.number()),
    taskStatus: v.string(),
    taskCreatedBy: v.optional(v.string()),
    taskCorClientId: v.optional(v.number()),
    taskCorClientName: v.optional(v.string()),
    // Shared
    threadId: v.string(),
    existingProjectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    // 1. Crear o reutilizar proyecto
    let projectId: string;
    if (args.existingProjectId) {
      projectId = args.existingProjectId;
      console.log(`[CreateProjectAndTask] ℹ️ Proyecto ya existe: ${projectId}`);
    } else {
      projectId = await ctx.db.insert("projects", {
        name: args.projectName,
        brief: args.projectBrief,
        startDate: new Date().toISOString().split("T")[0],
        endDate: args.projectEndDate,
        status: "active",
        pmId: args.projectPmId,
        deliverables: args.projectDeliverables,
        estimatedTime: args.projectEstimatedTime,
        createdBy: args.projectCreatedBy,
        threadId: args.threadId,
        corClientId: args.projectCorClientId,
        clientId: args.projectClientId,
        corSyncStatus: "pending",
      });
      console.log(`[CreateProjectAndTask] ✅ Proyecto creado: ${projectId}`);
    }

    // 2. Crear task
    const taskId = await ctx.db.insert("tasks", {
      title: args.taskTitle,
      description: args.taskDescription,
      deadline: args.taskDeadline,
      priority: args.taskPriority ?? 1,
      threadId: args.threadId,
      status: args.taskStatus,
      createdBy: args.taskCreatedBy,
      projectId: projectId as any,
      corSyncStatus: "pending",
      corClientId: args.taskCorClientId,
      corClientName: args.taskCorClientName,
    });
    console.log(`[CreateProjectAndTask] ✅ Task creada: ${taskId}`);

    return { projectId, taskId: taskId as string };
  },
});

/**
 * Programa la clasificación de prioridad estratégica en background.
 * La clasificación corre como un action separado (via scheduler) sin bloquear la creación.
 */
export const schedulePriorityClassification = internalMutation({
  args: {
    taskId: v.id("tasks"),
    title: v.string(),
    requestType: v.string(),
    brand: v.string(),
    objective: v.optional(v.string()),
    keyMessage: v.optional(v.string()),
    kpis: v.optional(v.string()),
    deadline: v.optional(v.string()),
    budget: v.optional(v.string()),
    approvers: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log(`[SchedulePriority] 🎯 Programando clasificación para task ${args.taskId}`);
    await ctx.scheduler.runAfter(0, internal.data.tasks.classifyAndUpdatePriority, {
      taskId: args.taskId,
      title: args.title,
      requestType: args.requestType,
      brand: args.brand,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      deadline: args.deadline,
      budget: args.budget,
      approvers: args.approvers,
    });
  },
});

/**
 * Action que clasifica la prioridad y actualiza la task (corre en background).
 * Llama al priorityAgent (cross-runtime, "use node") y luego actualiza description.
 */
export const classifyAndUpdatePriority = internalAction({
  args: {
    taskId: v.id("tasks"),
    title: v.string(),
    requestType: v.string(),
    brand: v.string(),
    objective: v.optional(v.string()),
    keyMessage: v.optional(v.string()),
    kpis: v.optional(v.string()),
    deadline: v.optional(v.string()),
    budget: v.optional(v.string()),
    approvers: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const classification = await ctx.runAction(internal.agents.priorityAgent.classifyPriorityAction, {
        title: args.title,
        requestType: args.requestType,
        brand: args.brand,
        objective: args.objective,
        keyMessage: args.keyMessage,
        kpis: args.kpis,
        deadline: args.deadline,
        budget: args.budget,
        approvers: args.approvers,
      });

      if (classification) {
        // Leer task actual y re-generar description con la prioridad
        const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
          taskId: args.taskId as string,
        });
        if (task?.description) {
          // Append al final del description existente
          const updatedDesc = task.description + `\nPrioridad Estratégica: ${classification}`;
          await ctx.runMutation(internal.data.tasks.updateTaskInternal, {
            taskId: args.taskId as string,
            updates: { description: updatedDesc },
          });
          console.log(`[ClassifyAndUpdate] ✅ Prioridad ${classification} añadida a task ${args.taskId}`);
        }
      }
    } catch (error) {
      console.log(`[ClassifyAndUpdate] ⚠️ No se pudo clasificar prioridad (task ${args.taskId}):`, error);
      // No falla — la task ya fue creada exitosamente
    }
  },
});

/**
 * Helper para asociar archivos del thread a una task.
 * Se ejecuta directamente como función TypeScript (sin runAction).
 * Ref: https://docs.convex.dev/functions/actions#await-ctxrunaction-should-only-be-used-for-crossing-js-runtimes
 */
export async function associateFilesHelper(
  ctx: ActionCtx,
  taskId: string,
  threadId: string,
): Promise<void> {
  console.log(`[AssociateFiles] Buscando archivos para task ${taskId}...`);

  try {
    const messagesResult = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });

    const allFileIds: string[] = [];
    for (const msg of messagesResult.page) {
      const msgAny = msg as any;
      if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
        allFileIds.push(...msgAny.fileIds);
      }
    }

    if (allFileIds.length === 0) {
      console.log(`[AssociateFiles] No se encontraron archivos en el thread`);
      return;
    }

    console.log(`[AssociateFiles] Creando ${allFileIds.length} registros en taskAttachments...`);

    for (const fileId of allFileIds) {
      try {
        const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
        if (fileInfo) {
          await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
            taskId: taskId as any,
            fileId,
            storageId: fileInfo.storageId,
            filename: fileInfo.filename,
            mimeType: fileInfo.mimeType,
            size: fileInfo.size,
          });
          console.log(`[AssociateFiles] ✅ Attachment creado: ${fileInfo.filename}`);
        }
      } catch (fileError) {
        console.error(`[AssociateFiles] ⚠️ Error con archivo ${fileId}:`, fileError);
      }
    }

    console.log(`[AssociateFiles] ✅ Archivos asociados exitosamente`);
  } catch (error) {
    console.error(`[AssociateFiles] Error:`, error);
  }
}


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
 * Mutation interna: programa la sincronización de ediciones locales hacia COR.
 * 
 * Verifica que la task esté publicada y luego schedula la action de sync.
 * Marca estado como "syncing" y resetea el attempt counter.
 * Uso: desde updateTaskFields (UI) y editTaskTool (agente) para unificar el flujo.
 */
export const scheduleTaskSyncToCOR = internalMutation({
  args: {
    taskId: v.id("tasks"),
    changedFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;

    if (task.corSyncStatus !== "synced" && task.corSyncStatus !== "retrying" && task.corSyncStatus !== "error") {
      if (!task.corTaskId) {
        console.log(`[scheduleTaskSyncToCOR] Task ${args.taskId} no está publicada en COR, omitiendo sync.`);
        return;
      }
    }

    if (!task.corTaskId) return;

    console.log(`[scheduleTaskSyncToCOR] 🔄 Programando sync para task ${args.taskId}`);
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.data.tasks.syncEditToCORAction, {
      taskId: args.taskId,
      changedFields: args.changedFields,
      attempt: 0,
    });
  },
});

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
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;
    console.log("\n========================================");
    console.log("[SyncEdit] 🔄 SINCRONIZANDO EDICIÓN LOCAL → COR");
    console.log(`[SyncEdit] Task Convex ID: ${args.taskId}`);
    console.log(`[SyncEdit] Campos cambiados: ${args.changedFields.join(", ")}`);
    console.log(`[SyncEdit] Intento: ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
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

      // Verificar que la task sigue en estado sincronizable
      if (!["synced", "syncing", "retrying"].includes(task.corSyncStatus || "")) {
        console.error(`[SyncEdit] ❌ Task no está en estado sincronizable (estado: ${task.corSyncStatus}). Abortando.`);
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
      } else {
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
          throw new Error(result.error || "Error desconocido de COR");
        }
      }

      // 5. Subir archivos pendientes a COR (no-fatal)
      try {
        await uploadPendingAttachmentsToCOR(ctx, args.taskId, parseInt(corTaskId));
      } catch (fileError) {
        console.error("[SyncEdit] ⚠️ Error subiendo archivos pendientes:", fileError);
      }

      // 6. Marcar como synced, actualizar hash y timestamp
      const successUpdate: Record<string, unknown> = {
        taskId: args.taskId,
        corSyncStatus: "synced",
        corSyncedAt: Date.now(),
      };
      if (updatePayload.description) {
        const newHash = hashText(updatePayload.description as string);
        successUpdate.corDescriptionHash = newHash;
        console.log(`[SyncEdit] ✅ Hash actualizado: ${newHash}`);
      }
      await ctx.runMutation(internal.data.tasks.updatePublishStatus, successUpdate as any);

      console.log(`[SyncEdit] ✅ Sincronización completada exitosamente`);
      console.log("========================================\n");

    } catch (error) {
      const errorMsg = formatRetryError(error);
      console.error(`[SyncEdit] ❌ Error en sincronización (intento ${attempt + 1}):`, errorMsg);

      // Errores 4xx son de validación/cliente — nunca se resuelven reintentando
      const canRetry = !isClientError(error) && shouldRetry(attempt);

      if (canRetry) {
        const delay = getRetryDelay(attempt)!;
        console.log(`[SyncEdit] 🔄 Reintentando en ${delay / 1000}s (intento ${attempt + 2}/${MAX_RETRY_ATTEMPTS})`);

        // Marcar como "retrying" con el error actual
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "retrying",
          corSyncError: `Intento ${attempt + 1}/${MAX_RETRY_ATTEMPTS} falló: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt + 1,
        });

        // Programar siguiente intento
        await ctx.scheduler.runAfter(delay, internal.data.tasks.syncEditToCORAction, {
          taskId: args.taskId,
          changedFields: args.changedFields,
          attempt: attempt + 1,
        });
      } else {
        // Error de cliente (4xx) o reintentos agotados → marcar como error definitivo
        if (isClientError(error)) {
          console.error(`[SyncEdit] 🚫 Error de cliente (4xx) — no se reintenta: ${errorMsg}`);
        } else {
          console.error(`[SyncEdit] 🚫 Reintentos agotados para task ${args.taskId}`);
        }
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: isClientError(error)
            ? `Error de validación COR (no reintentable): ${errorMsg}`
            : `Falló después de ${MAX_RETRY_ATTEMPTS} intentos. Último error: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt,
        });
      }
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
    corSyncAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {};
    if (args.corDescriptionHash !== undefined) updateData.corDescriptionHash = args.corDescriptionHash;
    if (args.corSyncedAt !== undefined) updateData.corSyncedAt = args.corSyncedAt;
    if (args.lastLocalEditAt !== undefined) updateData.lastLocalEditAt = args.lastLocalEditAt;
    if (args.corSyncAttempt !== undefined) updateData.corSyncAttempt = args.corSyncAttempt;
    
    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(args.taskId, updateData as any);
    }
  },
});

/**
 * Mutation pública: reintento manual de sincronización con COR.
 * Llamada desde la UI cuando el usuario hace clic en "Reintentar" después de un error.
 */
export const retryTaskSync = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // Verificar permisos (clientUserAssignments)
    if (task.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .filter((q) => q.eq(q.field("corClientId"), task.corClientId))
        .first();

      if (client) {
        const assignment = await ctx.db
          .query("clientUserAssignments")
          .withIndex("by_client_and_user", (q) =>
            q.eq("clientId", client._id).eq("userId", userId)
          )
          .first();

        if (!assignment) {
          throw new Error(
            `No tienes permisos para reintentar la sincronización de tasks del cliente "${task.corClientName || client.name}".`
          );
        }
      }
    }

    // Solo permitir retry si está en error o retrying
    if (!["error", "retrying"].includes(task.corSyncStatus || "")) {
      throw new Error("La task no está en estado de error para reintentar.");
    }

    // Si la task nunca fue publicada (no tiene corTaskId), reintentar publicación
    if (!task.corTaskId) {
      console.log(`[retryTaskSync] 🔄 Reintentando PUBLICACIÓN de task ${args.taskId}`);
      await ctx.db.patch(args.taskId, {
        corSyncStatus: "syncing",
        corSyncAttempt: 0,
        corSyncError: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.data.tasks.publishTaskToExternalAction, {
        taskId: args.taskId,
        attempt: 0,
      });
      return { success: true, message: "Publicación reintentada" };
    }

    // Si ya tiene corTaskId, reintentar sincronización de edición
    console.log(`[retryTaskSync] 🔄 Reintentando SYNC de task ${args.taskId}`);
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    // Sincronizar todos los campos sincronizables
    const allSyncFields = ["title", "description", "deadline", "priority", "status"];
    await ctx.scheduler.runAfter(0, internal.data.tasks.syncEditToCORAction, {
      taskId: args.taskId,
      changedFields: allSyncFields,
      attempt: 0,
    });

    return { success: true, message: "Sincronización reintentada" };
  },
});

// ==================== PUBLICAR TASK EN SISTEMA EXTERNO (COR) ====================

/**
 * Sube los attachments pendientes (sin corAttachmentId) de una task a COR.
 * Función reutilizable llamada desde publishTaskToExternalAction y syncEditToCORAction.
 * 
 * Flujo por attachment:
 * 1. Descarga el blob desde Convex storage
 * 2. Sube a COR via provider.uploadTaskAttachment (multipart/form-data)
 * 3. Marca como sincronizado (corAttachmentId + corUrl)
 * 
 * No lanza excepciones — los errores individuales se logean y se continúa.
 */
async function uploadPendingAttachmentsToCOR(
  ctx: ActionCtx,
  taskId: string,
  corTaskId: number,
): Promise<void> {
  const pendingAttachments = await ctx.runQuery(
    internal.data.tasks.getPendingAttachments,
    { taskId: taskId as any }
  );

  if (pendingAttachments.length === 0) return;

  console.log(`[Attachments] 📎 Subiendo ${pendingAttachments.length} archivos pendientes a COR task ${corTaskId}...`);
  const provider = getProjectManagementProvider();
  let uploaded = 0;

  for (const att of pendingAttachments) {
    try {
      // Descargar blob desde Convex storage
      const blob = await ctx.storage.get(att.storageId as any);
      if (!blob) {
        console.error(`[Attachments] ⚠️ Blob no encontrado para storageId ${att.storageId}, omitiendo`);
        continue;
      }

      const fileBuffer = await blob.arrayBuffer();

      // Subir a COR via multipart/form-data
      const result = await provider.uploadTaskAttachment({
        taskId: corTaskId,
        fileBuffer,
        filename: att.filename,
        mimeType: att.mimeType,
      });

      if (result.success && result.attachment) {
        // Marcar como sincronizado
        await ctx.runMutation(internal.data.tasks.updateAttachmentCORSync, {
          attachmentId: att._id,
          corAttachmentId: result.attachment.id,
          corUrl: result.attachment.url,
        });
        uploaded++;
        console.log(`[Attachments] ✅ ${att.filename} → COR attachment ${result.attachment.id}`);
      } else {
        console.error(`[Attachments] ⚠️ Error subiendo ${att.filename}: ${result.error}`);
      }
    } catch (fileError) {
      console.error(`[Attachments] ⚠️ Error con archivo ${att.filename}:`, fileError);
    }
  }

  console.log(`[Attachments] 📎 ${uploaded}/${pendingAttachments.length} archivos subidos exitosamente`);
}

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
    // Verificar autenticación usando getAuthUserId (consistente con el resto del codebase)
    const userId = await getAuthUserId(ctx);
    if (!userId) {
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
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error("La task ya está en proceso de publicación o sincronización. Espera a que termine.");
    }

    // Verificar que la task tiene un cliente asociado
    if (!task.corClientId) {
      throw new Error("No se puede publicar: no hay un cliente asociado a esta tarea.");
    }

    // Buscar el cliente local por corClientId
    const localClient = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", task.corClientId!))
      .unique();

    if (!localClient) {
      throw new Error("No se puede publicar: el cliente no está registrado en el sistema.");
    }

    // Obtener el usuario directamente por su ID (ya autenticado por getAuthUserId)
    const user = await ctx.db.get(userId);

    if (!user) {
      throw new Error("No se puede publicar: usuario no encontrado en el sistema.");
    }

    // Verificar que el usuario tiene autorización para este cliente
    const assignment = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", localClient._id).eq("userId", userId)
      )
      .unique();

    if (!assignment) {
      throw new Error(`No tienes autorización para crear tareas para el cliente "${localClient.name}". Contacta al administrador.`);
    }

    // Poner estado "syncing" — la UI lo verá inmediatamente
    await ctx.db.patch(args.taskId, {
      corSyncStatus: "syncing",
      corSyncError: undefined,
      corSyncAttempt: 0,
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
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;
    console.log("\n========================================");
    console.log("[PublishTask] 🚀 PUBLICANDO TASK EN SISTEMA EXTERNO");
    console.log(`[PublishTask] Task ID: ${args.taskId}`);
    console.log(`[PublishTask] Intento: ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
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
        status: task.status,
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

      // 6. Subir archivos pendientes a COR (no-fatal: la task ya está publicada)
      try {
        await uploadPendingAttachmentsToCOR(ctx, args.taskId, externalTask.id);
      } catch (fileError) {
        console.error("[PublishTask] ⚠️ Error subiendo archivos (task ya publicada):", fileError);
      }

      console.log("\n========================================");
      console.log("[PublishTask] 🏁 PUBLICACIÓN COMPLETADA");
      console.log(`[PublishTask] Proyecto: ${corProjectId}`);
      console.log(`[PublishTask] Task COR: ${externalTask.id}`);
      console.log("========================================\n");

    } catch (error) {
      const errorMsg = formatRetryError(error);
      console.error(`[PublishTask] ❌ Error publicando (intento ${attempt + 1}):`, errorMsg);
      
      // Errores 4xx son de validación/cliente — nunca se resuelven reintentando
      const canRetry = !isClientError(error) && shouldRetry(attempt);

      if (canRetry) {
        const delay = getRetryDelay(attempt)!;
        console.log(`[PublishTask] 🔄 Reintentando en ${delay / 1000}s (intento ${attempt + 2}/${MAX_RETRY_ATTEMPTS})`);

        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "retrying",
          corSyncError: `Intento ${attempt + 1}/${MAX_RETRY_ATTEMPTS} falló: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt + 1,
        });

        await ctx.scheduler.runAfter(delay, internal.data.tasks.publishTaskToExternalAction, {
          taskId: args.taskId,
          attempt: attempt + 1,
        });
      } else {
        if (isClientError(error)) {
          console.error(`[PublishTask] 🚫 Error de cliente (4xx) — no se reintenta: ${errorMsg}`);
        } else {
          console.error(`[PublishTask] 🚫 Reintentos agotados para task ${args.taskId}`);
        }
        await ctx.runMutation(internal.data.tasks.updatePublishStatus, {
          taskId: args.taskId,
          corSyncStatus: "error",
          corSyncError: isClientError(error)
            ? `Error de validación COR (no reintentable): ${errorMsg}`
            : `Falló después de ${MAX_RETRY_ATTEMPTS} intentos. Último error: ${errorMsg}`,
        });
        await ctx.runMutation(internal.data.tasks.updateSyncMetadata, {
          taskId: args.taskId,
          corSyncAttempt: attempt,
        });
      }
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
    
    // Auto-cleanup: cuando se marca "synced", limpiar error y resetear attempt
    if (args.corSyncStatus === "synced") {
      updateData.corSyncError = undefined;
      updateData.corSyncAttempt = 0;
    }
    
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
