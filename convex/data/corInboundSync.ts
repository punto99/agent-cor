// convex/data/corInboundSync.ts
// =====================================================
// Sync inbound: COR → Convex
//
// Permite al usuario traer manualmente los últimos datos de COR
// para actualizar una task y su proyecto en Convex.
// COR es la fuente de verdad — si algo cambió allá, se refleja acá.
//
// Flujo:
//   1. Usuario clickea RefreshCcw en el dialog
//   2. startPullFromCOR (mutation) verifica auth/permisos y schedula la action
//   3. pullFromCORAction (action) llama a COR API y ejecuta mutations de update
//   4. applyInboundTaskUpdate / applyInboundProjectUpdate aplican cambios atómicamente
// =====================================================

import { v } from "convex/values";
import {
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { internal, components } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { storeFile } from "@convex-dev/agent";
import { getProjectManagementProvider } from "../integrations/registry";
import { CORNotFoundError } from "../integrations/corProvider";
import { hashText } from "../lib/briefFormat";

const SCHEDULED_SYNC_BATCH_SIZE = 100;
const TASK_LOCAL_EDIT_GRACE_MS = 60_000;

function parseCORTaskId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function syncTaskAttachmentsFromCOR(
  ctx: any,
  taskId: Id<"tasks">,
  corTaskId: number,
): Promise<void> {
  const provider = getProjectManagementProvider();
  const remoteAttachments = await provider.getTaskAttachments(corTaskId);
  const localAttachments = await ctx.runQuery(internal.data.tasks.getTaskAttachments, {
    taskId,
  });

  const remoteById = new Map<number, (typeof remoteAttachments)[number]>();
  for (const remote of remoteAttachments) {
    if (Number.isFinite(remote.id)) remoteById.set(remote.id, remote);
  }

  const localByCorId = new Map<number, (typeof localAttachments)[number]>();
  for (const local of localAttachments) {
    if (typeof local.corAttachmentId === "number") {
      localByCorId.set(local.corAttachmentId, local);
    }
  }

  let deletedCount = 0;
  for (const [corAttachmentId, localAttachment] of localByCorId.entries()) {
    if (!remoteById.has(corAttachmentId)) {
      await ctx.runMutation(internal.data.tasks.deleteTaskAttachment, {
        attachmentId: localAttachment._id,
      });
      deletedCount += 1;
    }
  }

  let addedCount = 0;
  for (const [corAttachmentId, remoteAttachment] of remoteById.entries()) {
    if (localByCorId.has(corAttachmentId)) continue;
    if (!remoteAttachment.url) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Attachment ${corAttachmentId} sin URL en COR, se omite`
      );
      continue;
    }

    try {
      const response = await fetch(remoteAttachment.url);
      if (!response.ok) {
        console.warn(
          `[InboundSync][Attachments] ⚠️ No se pudo descargar attachment ${corAttachmentId} (${response.status})`
        );
        continue;
      }

      const buffer = await response.arrayBuffer();
      const mimeType = remoteAttachment.mimeType || response.headers.get("content-type") || "application/octet-stream";
      const filename = remoteAttachment.name || `attachment_${corAttachmentId}`;

      const { file } = await storeFile(
        ctx,
        components.agent,
        new Blob([buffer], { type: mimeType }),
        { filename },
      );

      const attachmentId = await ctx.runMutation(internal.data.tasks.createTaskAttachment, {
        taskId,
        fileId: file.fileId,
        storageId: String(file.storageId),
        filename,
        mimeType,
        size: remoteAttachment.size ?? buffer.byteLength,
      });

      await ctx.runMutation(internal.data.tasks.updateAttachmentCORSync, {
        attachmentId,
        corAttachmentId,
        corUrl: remoteAttachment.url,
      });

      addedCount += 1;
    } catch (error) {
      console.warn(
        `[InboundSync][Attachments] ⚠️ Error sincronizando attachment ${corAttachmentId}:`,
        error
      );
    }
  }

  if (addedCount > 0 || deletedCount > 0) {
    console.log(
      `[InboundSync][Attachments] ✅ Task ${taskId}: +${addedCount} / -${deletedCount}`
    );
  }
}

// ==================== ENTRY POINT (pública) ====================

/**
 * Mutation pública: el usuario solicita actualizar una task desde COR.
 * Verifica auth + permisos + que la task esté publicada.
 * Schedula la action via scheduler para no bloquear la UI.
 */
export const startPullFromCOR = mutation({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    // 1. Auth
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    // 2. Leer task
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task no encontrada");

    // 3. Solo permitir pull si está publicada y en estado estable
    if (!task.corTaskId) {
      throw new Error("La task no está publicada en el sistema externo.");
    }
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      throw new Error(
        "La task se está sincronizando. Espera a que termine antes de actualizar."
      );
    }

    // 4. Verificar permisos (clientUserAssignments)
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
            `No tienes permisos para actualizar tasks del cliente "${task.corClientName || client.name}".`
          );
        }
      }
    }

    // 5. Programar la action (no bloquea UI)
    await ctx.scheduler.runAfter(
      0,
      internal.data.corInboundSync.pullFromCORAction,
      {
        taskId: args.taskId,
      }
    );

    return { success: true };
  },
});

// ==================== ACTION: llamada a COR ====================

/**
 * Action interna: consulta COR API y actualiza task + proyecto en Convex.
 * Máximo 2 llamadas HTTP: una para task, una para proyecto.
 */
export const pullFromCORAction = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    console.log("\n========================================");
    console.log("[InboundSync] 🔄 PULL COR → CONVEX");
    console.log(`[InboundSync] Task Convex ID: ${args.taskId}`);
    console.log("========================================\n");

    try {
      // 1. Leer task de Convex para obtener IDs de COR
      const task = await ctx.runQuery(
        internal.data.tasks.getTaskByIdInternal,
        { taskId: args.taskId as string }
      );

      if (!task) {
        console.error("[InboundSync] ❌ Task no encontrada en Convex");
        return;
      }

      if (!task.corTaskId) {
        console.error("[InboundSync] ❌ Task no tiene corTaskId");
        return;
      }

      const provider = getProjectManagementProvider();
      const corTaskId = parseCORTaskId(task.corTaskId);
      if (corTaskId === null) {
        console.error(
          `[InboundSync] ❌ corTaskId inválido para task ${args.taskId}: ${String(task.corTaskId)}`
        );
        return;
      }

      // 2. Traer task de COR
      console.log(
        `[InboundSync] 📡 Consultando task COR ${task.corTaskId}...`
      );
      let corTask = null;
      try {
        corTask = await provider.getTask(corTaskId);
      } catch (error) {
        if (error instanceof CORNotFoundError) {
          await ctx.runMutation(
            internal.data.corInboundSync.setTaskNotFoundInCOR,
            {
              taskId: args.taskId,
              missing: true,
            }
          );
          console.warn(
            `[InboundSync] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`
          );
          corTask = null;
        } else {
          throw error;
        }
      }

      if (!corTask) {
        console.warn(
          `[InboundSync] ⚠️ Task COR ${task.corTaskId} no encontrada (¿eliminada?)`
        );
      } else {
        await ctx.runMutation(internal.data.corInboundSync.setTaskNotFoundInCOR, {
          taskId: args.taskId,
          missing: false,
        });

        // Aplicar cambios de la task
        await ctx.runMutation(
          internal.data.corInboundSync.applyInboundTaskUpdate,
          {
            taskId: args.taskId,
            corTitle: corTask.title,
            corDescription: corTask.description ?? undefined,
            corDeadline: corTask.deadline ?? undefined,
            corPriority: corTask.priority ?? undefined,
            corStatus: corTask.status ?? undefined,
          }
        );

        await syncTaskAttachmentsFromCOR(
          ctx,
          args.taskId,
          corTaskId,
        );
      }

      // 3. Traer proyecto de COR (si la task tiene corProjectId)
      if (task.corProjectId && task.projectId) {
        console.log(
          `[InboundSync] 📡 Consultando proyecto COR ${task.corProjectId}...`
        );
        let corProject = null;
        try {
          corProject = await provider.getProject(task.corProjectId);
        } catch (error) {
          if (error instanceof CORNotFoundError) {
            await ctx.runMutation(
              internal.data.corInboundSync.setProjectNotFoundInCOR,
              {
                projectId: task.projectId,
                missing: true,
              }
            );
            console.warn(
              `[InboundSync] ⚠️ Proyecto COR ${task.corProjectId} no encontrado para proyecto ${task.projectId}`
            );
            corProject = null;
          } else {
            throw error;
          }
        }

        if (!corProject) {
          console.warn(
            `[InboundSync] ⚠️ Proyecto COR ${task.corProjectId} no encontrado (¿eliminado?)`
          );
        } else {
          await ctx.runMutation(
            internal.data.corInboundSync.setProjectNotFoundInCOR,
            {
              projectId: task.projectId,
              missing: false,
            }
          );
          await ctx.runMutation(
            internal.data.corInboundSync.applyInboundProjectUpdate,
            {
              projectId: task.projectId,
              corName: corProject.name,
              corBrief: corProject.brief ?? undefined,
              corStartDate: corProject.startDate ?? undefined,
              corEndDate: corProject.endDate ?? undefined,
              corDeliverables: corProject.deliverables ?? undefined,
              corStatus: corProject.status ?? undefined,
              corEstimatedTime: corProject.estimatedTime ?? undefined,
            }
          );
        }
      }

      console.log("[InboundSync] ✅ Pull completado");
      console.log("========================================\n");
    } catch (error) {
      console.error(
        "[InboundSync] ❌ Error en pull:",
        error instanceof Error ? error.message : error
      );
    }
  },
});

// ==================== SCHEDULED INBOUND SYNC (cron) ====================

/**
 * Lista paginada de tasks locales para sync programado.
 * Incluye todas las tasks de la tabla; las no publicadas se omiten en worker.
 */
export const listTasksForScheduledPull = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .filter((q) => q.neq(q.field("convexStatus"), "deleted"))
      .order("asc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Lista paginada de proyectos locales para sync programado.
 * Incluye todos los proyectos de la tabla; los no publicados se omiten en worker.
 */
export const listProjectsForScheduledPull = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .filter((q) => q.neq(q.field("convexStatus"), "deleted"))
      .order("asc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Orquestador programado por cron (cada 10 min).
 * Recorre completamente tasks y proyectos en lotes y schedula workers para cada entidad.
 */
export const runScheduledInboundSyncAction = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("\n========================================");
    console.log("[InboundSync][Cron] ⏱️ Inicio corrida programada COR → Convex");
    console.log("========================================\n");

    let taskCount = 0;
    let projectCount = 0;

    let taskCursor: string | null = null;
    while (true) {
      const tasksPage: {
        page: Array<{ _id: Id<"tasks"> }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        internal.data.corInboundSync.listTasksForScheduledPull,
        {
          paginationOpts: { cursor: taskCursor, numItems: SCHEDULED_SYNC_BATCH_SIZE },
        }
      );

      for (const task of tasksPage.page) {
        await ctx.scheduler.runAfter(
          0,
          internal.data.corInboundSync.pullTaskFromCORWorker,
          { taskId: task._id }
        );
        taskCount += 1;
      }

      if (tasksPage.isDone) break;
      taskCursor = tasksPage.continueCursor;
    }

    let projectCursor: string | null = null;
    while (true) {
      const projectsPage: {
        page: Array<{ _id: Id<"projects"> }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        internal.data.corInboundSync.listProjectsForScheduledPull,
        {
          paginationOpts: {
            cursor: projectCursor,
            numItems: SCHEDULED_SYNC_BATCH_SIZE,
          },
        }
      );

      for (const project of projectsPage.page) {
        await ctx.scheduler.runAfter(
          0,
          internal.data.corInboundSync.pullProjectFromCORWorker,
          { projectId: project._id }
        );
        projectCount += 1;
      }

      if (projectsPage.isDone) break;
      projectCursor = projectsPage.continueCursor;
    }

    console.log(
      `[InboundSync][Cron] ✅ Corrida programada despachada. Tasks: ${taskCount}, Proyectos: ${projectCount}`
    );
  },
});

/**
 * Worker de task para sync inbound programado.
 * Evita conflictos saltando tasks en syncing/retrying o recién editadas localmente.
 */
export const pullTaskFromCORWorker = internalAction({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(internal.data.tasks.getTaskByIdInternal, {
      taskId: args.taskId as unknown as string,
    });

    if (!task) return;

    if (!task.corTaskId) {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} sin corTaskId, se omite` 
      );
      return;
    }

    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} en ${task.corSyncStatus}, se omite` 
      );
      return;
    }

    if (
      task.lastLocalEditAt &&
      Date.now() - task.lastLocalEditAt < TASK_LOCAL_EDIT_GRACE_MS
    ) {
      console.log(
        `[InboundSync][Cron] ⏭️ Task ${args.taskId} editada recientemente, se omite` 
      );
      return;
    }

    const corTaskId = parseCORTaskId(task.corTaskId);
    if (corTaskId === null) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Task ${args.taskId} tiene corTaskId inválido (${task.corTaskId})`
      );
      return;
    }

    const provider = getProjectManagementProvider();
    let corTask = null;
    try {
      corTask = await provider.getTask(corTaskId);
    } catch (error) {
      if (error instanceof CORNotFoundError) {
        await ctx.runMutation(internal.data.corInboundSync.setTaskNotFoundInCOR, {
          taskId: args.taskId,
          missing: true,
        });
        console.warn(
          `[InboundSync][Cron] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`
        );
        return;
      }
      throw error;
    }
    if (!corTask) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Task COR ${task.corTaskId} no encontrada para task ${args.taskId}`
      );
      return;
    }

    await ctx.runMutation(internal.data.corInboundSync.setTaskNotFoundInCOR, {
      taskId: args.taskId,
      missing: false,
    });

    await ctx.runMutation(internal.data.corInboundSync.applyInboundTaskUpdate, {
      taskId: args.taskId,
      corTitle: corTask.title,
      corDescription: corTask.description ?? undefined,
      corDeadline: corTask.deadline ?? undefined,
      corPriority: corTask.priority ?? undefined,
      corStatus: corTask.status ?? undefined,
    });

    await syncTaskAttachmentsFromCOR(
      ctx,
      args.taskId,
      corTaskId,
    );
  },
});

/**
 * Worker de proyecto para sync inbound programado.
 * Evita conflictos saltando proyectos en syncing/retrying.
 */
export const pullProjectFromCORWorker = internalAction({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
      projectId: args.projectId,
    });

    if (!project) return;

    if (!project.corProjectId) {
      console.log(
        `[InboundSync][Cron] ⏭️ Proyecto ${args.projectId} sin corProjectId, se omite`
      );
      return;
    }

    if (
      project.corSyncStatus === "syncing" ||
      project.corSyncStatus === "retrying"
    ) {
      console.log(
        `[InboundSync][Cron] ⏭️ Proyecto ${args.projectId} en ${project.corSyncStatus}, se omite`
      );
      return;
    }

    const provider = getProjectManagementProvider();
    let corProject = null;
    try {
      corProject = await provider.getProject(project.corProjectId);
    } catch (error) {
      if (error instanceof CORNotFoundError) {
        await ctx.runMutation(
          internal.data.corInboundSync.setProjectNotFoundInCOR,
          {
            projectId: args.projectId,
            missing: true,
          }
        );
        console.warn(
          `[InboundSync][Cron] ⚠️ Proyecto COR ${project.corProjectId} no encontrado para proyecto ${args.projectId}`
        );
        return;
      }
      throw error;
    }
    if (!corProject) {
      console.warn(
        `[InboundSync][Cron] ⚠️ Proyecto COR ${project.corProjectId} no encontrado para proyecto ${args.projectId}`
      );
      return;
    }

    await ctx.runMutation(internal.data.corInboundSync.setProjectNotFoundInCOR, {
      projectId: args.projectId,
      missing: false,
    });

    await ctx.runMutation(
      internal.data.corInboundSync.applyInboundProjectUpdate,
      {
        projectId: args.projectId,
        corName: corProject.name,
        corBrief: corProject.brief ?? undefined,
        corStartDate: corProject.startDate ?? undefined,
        corEndDate: corProject.endDate ?? undefined,
        corDeliverables: corProject.deliverables ?? undefined,
        corStatus: corProject.status ?? undefined,
        corEstimatedTime: corProject.estimatedTime ?? undefined,
      }
    );
  },
});

/**
 * Marca si la task local ya no existe en COR.
 */
export const setTaskNotFoundInCOR = internalMutation({
  args: {
    taskId: v.id("tasks"),
    missing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;

    if (args.missing) {
      await ctx.db.patch(args.taskId, {
        corTaskMissingInCOR: true,
        corSyncError:
          "No encontrada en COR: la tarea no fue encontrada en COR y posiblemente fue eliminada.",
      });
      return;
    }

    const patch: Record<string, string | boolean> = {
      corTaskMissingInCOR: false,
    };

    if (
      task.corSyncError?.startsWith("Eliminado en COR:") ||
      task.corSyncError?.startsWith("No encontrada en COR:")
    ) {
      patch.corSyncError = "";
    }

    await ctx.db.patch(args.taskId, patch as any);
  },
});

/**
 * Marca si el proyecto local ya no existe en COR y propaga el estado a sus tasks.
 */
export const setProjectNotFoundInCOR = internalMutation({
  args: {
    projectId: v.id("projects"),
    missing: v.boolean(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;

    if (args.missing) {
      await ctx.db.patch(args.projectId, {
        corMissingInCOR: true,
        corSyncError:
          "No encontrado en COR: el proyecto no fue encontrado en COR y posiblemente fue eliminado.",
      });
    } else {
      const patch: Record<string, string | boolean> = {
        corMissingInCOR: false,
      };

      if (
        project.corSyncError?.startsWith("Eliminado en COR:") ||
        project.corSyncError?.startsWith("No encontrado en COR:")
      ) {
        patch.corSyncError = "";
      }

      await ctx.db.patch(args.projectId, patch as any);
    }

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const task of tasks) {
      await ctx.db.patch(task._id, {
        corProjectMissingInCOR: args.missing,
      });
    }
  },
});

// ==================== MUTATIONS: aplicar cambios ====================

/**
 * Aplica cambios de COR a una task en Convex.
 * Guarda atómica: si corSyncStatus cambió (outbound sync en curso), aborta.
 * Solo escribe si al menos un campo cambió (evita re-renders innecesarios).
 */
export const applyInboundTaskUpdate = internalMutation({
  args: {
    taskId: v.id("tasks"),
    corTitle: v.string(),
    corDescription: v.optional(v.string()),
    corDeadline: v.optional(v.string()),
    corPriority: v.optional(v.number()),
    corStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Re-leer la task (estado fresco, atómico dentro de la mutation)
    const task = await ctx.db.get(args.taskId);
    if (!task) return;

    // Guarda de conflicto: si un outbound sync se inició, no tocar
    if (
      task.corSyncStatus !== "synced" &&
      task.corSyncStatus !== "error" &&
      task.corSyncStatus !== "pending"
    ) {
      console.log(
        `[InboundSync] ⏭️ Task ${args.taskId} en estado "${task.corSyncStatus}", omitiendo update inbound`
      );
      return;
    }

    // Comparar campos — solo escribir si hay diferencia
    const updates: Record<string, unknown> = {};

    if (args.corTitle !== task.title) updates.title = args.corTitle;
    if (args.corDescription !== undefined && args.corDescription !== (task.description ?? "")) {
      updates.description = args.corDescription;
    }
    if (args.corDeadline !== undefined && args.corDeadline !== task.deadline) {
      updates.deadline = args.corDeadline;
    }
    if (args.corPriority !== undefined && args.corPriority !== task.priority) {
      updates.priority = args.corPriority;
    }
    if (args.corStatus !== undefined && args.corStatus !== task.status) {
      updates.status = args.corStatus;
    }

    if (Object.keys(updates).length === 0) {
      console.log(
        `[InboundSync] ✅ Task ${args.taskId} ya está al día — sin cambios`
      );
      return;
    }

    // Actualizar timestamps de sync (NO lastLocalEditAt — esto no es edición local)
    updates.corSyncedAt = Date.now();
    if (updates.description) {
      updates.corDescriptionHash = hashText(updates.description as string);
    }

    await ctx.db.patch(args.taskId, updates as any);
    console.log(
      `[InboundSync] ✅ Task ${args.taskId} actualizada: ${Object.keys(updates).filter((k) => !k.startsWith("cor")).join(", ")}`
    );
  },
});

/**
 * Aplica cambios de COR a un proyecto en Convex.
 * Misma lógica de guarda atómica y comparación que la task.
 */
export const applyInboundProjectUpdate = internalMutation({
  args: {
    projectId: v.id("projects"),
    corName: v.string(),
    corBrief: v.optional(v.string()),
    corStartDate: v.optional(v.string()),
    corEndDate: v.optional(v.string()),
    corDeliverables: v.optional(v.number()),
    corStatus: v.optional(v.string()),
    corEstimatedTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;

    // Guarda de conflicto
    if (
      project.corSyncStatus !== "synced" &&
      project.corSyncStatus !== "error" &&
      project.corSyncStatus !== "pending"
    ) {
      console.log(
        `[InboundSync] ⏭️ Proyecto ${args.projectId} en estado "${project.corSyncStatus}", omitiendo update inbound`
      );
      return;
    }

    // Comparar campos
    const updates: Record<string, unknown> = {};

    if (args.corName !== project.name) updates.name = args.corName;
    if (args.corBrief !== undefined && args.corBrief !== (project.brief ?? "")) {
      updates.brief = args.corBrief;
    }
    if (args.corStartDate !== undefined && args.corStartDate !== project.startDate) {
      updates.startDate = args.corStartDate;
    }
    if (args.corEndDate !== undefined && args.corEndDate !== project.endDate) {
      updates.endDate = args.corEndDate;
    }
    if (args.corDeliverables !== undefined && args.corDeliverables !== project.deliverables) {
      updates.deliverables = args.corDeliverables;
    }
    if (args.corStatus !== undefined && args.corStatus !== project.status) {
      updates.status = args.corStatus;
    }
    if (args.corEstimatedTime !== undefined && args.corEstimatedTime !== project.estimatedTime) {
      updates.estimatedTime = args.corEstimatedTime;
    }

    if (Object.keys(updates).length === 0) {
      console.log(
        `[InboundSync] ✅ Proyecto ${args.projectId} ya está al día — sin cambios`
      );
      return;
    }

    updates.corSyncedAt = Date.now();

    await ctx.db.patch(args.projectId, updates as any);
    console.log(
      `[InboundSync] ✅ Proyecto ${args.projectId} actualizado: ${Object.keys(updates).filter((k) => !k.startsWith("cor")).join(", ")}`
    );
  },
});
