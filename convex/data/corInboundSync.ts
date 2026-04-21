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
  internalMutation,
  internalAction,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getProjectManagementProvider } from "../integrations/registry";
import { hashText } from "../lib/briefFormat";

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

      // 2. Traer task de COR
      console.log(
        `[InboundSync] 📡 Consultando task COR ${task.corTaskId}...`
      );
      const corTask = await provider.getTask(parseInt(task.corTaskId));

      if (!corTask) {
        console.warn(
          `[InboundSync] ⚠️ Task COR ${task.corTaskId} no encontrada (¿eliminada?)`
        );
      } else {
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
      }

      // 3. Traer proyecto de COR (si la task tiene corProjectId)
      if (task.corProjectId && task.projectId) {
        console.log(
          `[InboundSync] 📡 Consultando proyecto COR ${task.corProjectId}...`
        );
        const corProject = await provider.getProject(task.corProjectId);

        if (!corProject) {
          console.warn(
            `[InboundSync] ⚠️ Proyecto COR ${task.corProjectId} no encontrado (¿eliminado?)`
          );
        } else {
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
    corDeliverables: v.optional(v.string()),
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
    if (args.corDeliverables !== undefined && args.corDeliverables !== (project.deliverables ?? "")) {
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
