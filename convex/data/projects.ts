// convex/data/projects.ts
// =====================================================
// CRUD de proyectos locales (tabla intermedia Client → Project → Task).
//
// Los proyectos se crean primero en Convex (editables en Panel de Control).
// Cuando el usuario publica, se sincronizan a COR.
// =====================================================

import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  internalAction,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getProjectManagementProvider } from "../integrations/registry";
import { shouldRetry, getRetryDelay, formatRetryError, isClientError, MAX_RETRY_ATTEMPTS } from "../lib/corRetry";

// ==================== QUERIES ====================

/**
 * Obtiene un proyecto por su ID.
 */
export const getProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    return await ctx.db.get(args.projectId);
  },
});

/**
 * Lista proyectos creados por el usuario autenticado.
 */
export const listMyProjects = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    return await ctx.db
      .query("projects")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", userId))
      .collect();
  },
});

/**
 * Busca un proyecto por threadId.
 * Uso interno — el agente necesita saber si ya existe un proyecto para el thread actual.
 */
export const getProjectByThread = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
  },
});

/**
 * Obtiene un proyecto por su ID (uso interno desde actions).
 */
export const getProjectInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.projectId);
  },
});

// ==================== MUTATIONS ====================

/**
 * Crea un proyecto local en Convex.
 * Llamado internamente por el flujo del createTaskTool.
 * El proyecto nace con corSyncStatus = "pending" (editable antes de publicar).
 */
export const createProjectInternal = internalMutation({
  args: {
    name: v.string(),
    brief: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    status: v.string(),
    clientId: v.optional(v.id("corClients")),
    createdBy: v.optional(v.string()),
    threadId: v.optional(v.string()),
    corClientId: v.optional(v.number()),
    pmId: v.optional(v.number()),
    deliverables: v.optional(v.number()),
    estimatedTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const projectId = await ctx.db.insert("projects", {
      name: args.name,
      brief: args.brief,
      startDate: args.startDate,
      endDate: args.endDate,
      status: args.status,
      clientId: args.clientId,
      createdBy: args.createdBy,
      threadId: args.threadId,
      corClientId: args.corClientId,
      pmId: args.pmId,
      deliverables: args.deliverables,
      estimatedTime: args.estimatedTime,
      corSyncStatus: "pending",
    });

    console.log(`[projects] ✅ Proyecto creado: "${args.name}" (ID: ${projectId})`);
    return projectId;
  },
});

/**
 * Actualiza campos de un proyecto existente.
 * Usado desde el Panel de Control para edición pre/post-publicación.
 * Si el proyecto está publicado en COR, dispara sincronización automática.
 */
export const updateProjectFields = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    brief: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    status: v.optional(v.string()),
    estimatedTime: v.optional(v.number()),
    billable: v.optional(v.boolean()),
    incomeType: v.optional(v.string()),
    deliverables: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Proyecto no encontrado");

    // ─── Bloquear edición durante sincronización ───
    if (project.corSyncStatus === "syncing" || project.corSyncStatus === "retrying") {
      throw new Error(
        "El proyecto se está sincronizando con el sistema externo. Espera a que termine la sincronización antes de editar."
      );
    }

    // ─── Validación de permisos (clientUserAssignments) ───
    if (project.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .filter((q) => q.eq(q.field("corClientId"), project.corClientId))
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
              `No tienes permisos para editar proyectos del cliente "${client.name}".`
            );
          }
        }
      }
    }

    // Construir objeto de actualización solo con los campos proporcionados
    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.brief !== undefined) updates.brief = args.brief;
    if (args.startDate !== undefined) updates.startDate = args.startDate;
    if (args.endDate !== undefined) updates.endDate = args.endDate;
    if (args.status !== undefined) updates.status = args.status;
    if (args.estimatedTime !== undefined) updates.estimatedTime = args.estimatedTime;
    if (args.billable !== undefined) updates.billable = args.billable;
    if (args.incomeType !== undefined) updates.incomeType = args.incomeType;
    if (args.deliverables !== undefined) updates.deliverables = args.deliverables;

    if (Object.keys(updates).length === 0) return;

    await ctx.db.patch(args.projectId, updates);
    console.log(`[projects] ✅ Proyecto "${project.name}" actualizado (${Object.keys(updates).join(", ")})`);

    // Programar sync a COR si corresponde
    const changedFields = Object.keys(updates);
    await ctx.scheduler.runAfter(0, internal.data.projects.scheduleProjectSyncToCOR, {
      projectId: args.projectId,
      changedFields,
    });
  },
});

/**
 * Mutation interna para actualizar un proyecto (llamada desde editProjectTool del agente).
 */
export const updateProjectInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    updates: v.object({
      name: v.optional(v.string()),
      brief: v.optional(v.string()),
      startDate: v.optional(v.string()),
      endDate: v.optional(v.string()),
      deliverables: v.optional(v.number()),
      estimatedTime: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    console.log(`[projects.updateProjectInternal] Actualizando proyecto ${args.projectId}...`);

    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.updates)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    if (Object.keys(updateData).length === 0) return args.projectId;

    await ctx.db.patch(args.projectId, updateData);
    console.log(`[projects.updateProjectInternal] ✅ Proyecto actualizado`);
    return args.projectId;
  },
});

/**
 * Mutation interna: programa la sincronización de ediciones locales hacia COR.
 * Verifica que el proyecto esté publicado, marca "syncing" y schedula la action.
 */
export const scheduleProjectSyncToCOR = internalMutation({
  args: {
    projectId: v.id("projects"),
    changedFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return;

    if (!project.corProjectId) {
      console.log(`[scheduleProjectSyncToCOR] Proyecto ${args.projectId} no está publicado en COR, omitiendo sync.`);
      return;
    }

    // Solo permitir sync si el proyecto está en estado sincronizable
    if (!project.corProjectId) return;
    if (!["synced", "retrying", "error"].includes(project.corSyncStatus || "")) {
      console.log(`[scheduleProjectSyncToCOR] Proyecto ${args.projectId} en estado "${project.corSyncStatus}", omitiendo sync.`);
      return;
    }

    console.log(`[scheduleProjectSyncToCOR] 🔄 Programando sync para proyecto ${args.projectId}`);
    await ctx.db.patch(args.projectId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.data.projects.syncProjectEditToCORAction, {
      projectId: args.projectId,
      changedFields: args.changedFields,
      attempt: 0,
    });
  },
});

/**
 * Campos de proyecto que tienen equivalente directo en COR.
 */
const COR_PROJECT_SYNCABLE_FIELDS = new Set([
  "name", "brief", "startDate", "endDate", "deliverables", "estimatedTime", "status",
]);

/**
 * Action interna: sincroniza una edición local de proyecto hacia COR.
 * Incluye reintentos automáticos con backoff exponencial.
 */
export const syncProjectEditToCORAction = internalAction({
  args: {
    projectId: v.id("projects"),
    changedFields: v.array(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;
    console.log("\n========================================");
    console.log("[SyncProjectEdit] 🔄 SINCRONIZANDO PROYECTO → COR");
    console.log(`[SyncProjectEdit] Proyecto Convex ID: ${args.projectId}`);
    console.log(`[SyncProjectEdit] Campos cambiados: ${args.changedFields.join(", ")}`);
    console.log(`[SyncProjectEdit] Intento: ${attempt + 1}/${MAX_RETRY_ATTEMPTS}`);
    console.log("========================================\n");

    try {
      const project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
        projectId: args.projectId,
      });

      if (!project) {
        console.error("[SyncProjectEdit] ❌ Proyecto no encontrado en Convex");
        return;
      }

      if (!["synced", "syncing", "retrying"].includes(project.corSyncStatus || "")) {
        console.error(`[SyncProjectEdit] ❌ Proyecto no está en estado sincronizable (estado: ${project.corSyncStatus}). Abortando.`);
        return;
      }

      const corProjectId = project.corProjectId;
      if (!corProjectId) {
        console.error("[SyncProjectEdit] ❌ Proyecto no tiene corProjectId. Abortando.");
        return;
      }

      // Solo sincronizar campos que aplican
      const syncableChanges = args.changedFields.filter((f) => COR_PROJECT_SYNCABLE_FIELDS.has(f));
      if (syncableChanges.length === 0) {
        console.log("[SyncProjectEdit] ℹ️ No hay campos sincronizables con COR");
        // Restaurar a synced ya que no hay nada que sincronizar
        await ctx.runMutation(internal.data.projects.updateProjectPublishStatus, {
          projectId: args.projectId,
          corSyncStatus: "synced",
        });
        return;
      }

      console.log(`[SyncProjectEdit] 📝 Campos a sincronizar: ${syncableChanges.join(", ")}`);

      const updatePayload: Record<string, unknown> = {};
      if (syncableChanges.includes("name")) updatePayload.name = project.name;
      if (syncableChanges.includes("brief")) updatePayload.brief = project.brief;
      if (syncableChanges.includes("startDate")) updatePayload.startDate = project.startDate;
      if (syncableChanges.includes("endDate")) updatePayload.endDate = project.endDate;
      if (syncableChanges.includes("deliverables")) updatePayload.deliverables = project.deliverables;
      if (syncableChanges.includes("estimatedTime")) updatePayload.estimatedTime = project.estimatedTime;
      if (syncableChanges.includes("status")) updatePayload.status = project.status;

      const provider = getProjectManagementProvider();
      const result = await provider.updateProject(corProjectId, updatePayload as any);

      if (!result.success) {
        throw new Error(result.error || "Error desconocido de COR");
      }

      // ÉXITO — marcar como synced y limpiar estado de retry
      await ctx.runMutation(internal.data.projects.updateProjectSyncMetadata, {
        projectId: args.projectId,
        corSyncStatus: "synced",
        corSyncedAt: Date.now(),
        corSyncAttempt: 0,
        corSyncError: undefined,
      });

      console.log(`[SyncProjectEdit] ✅ Sincronización completada`);
      console.log("========================================\n");
    } catch (error) {
      const errorMsg = formatRetryError(error);
      console.error(`[SyncProjectEdit] ❌ Error (intento ${attempt + 1}):`, errorMsg);

      // Errores 4xx son de validación/cliente — nunca se resuelven reintentando
      const canRetry = !isClientError(error) && shouldRetry(attempt);

      if (canRetry) {
        const delay = getRetryDelay(attempt)!;
        console.log(`[SyncProjectEdit] 🔄 Reintentando en ${delay / 1000}s (intento ${attempt + 2}/${MAX_RETRY_ATTEMPTS})`);

        await ctx.runMutation(internal.data.projects.updateProjectSyncMetadata, {
          projectId: args.projectId,
          corSyncStatus: "retrying",
          corSyncError: `Intento ${attempt + 1}/${MAX_RETRY_ATTEMPTS} falló: ${errorMsg}`,
          corSyncAttempt: attempt + 1,
        });

        await ctx.scheduler.runAfter(delay, internal.data.projects.syncProjectEditToCORAction, {
          projectId: args.projectId,
          changedFields: args.changedFields,
          attempt: attempt + 1,
        });
      } else {
        if (isClientError(error)) {
          console.error(`[SyncProjectEdit] 🚫 Error de cliente (4xx) — no se reintenta: ${errorMsg}`);
        } else {
          console.error(`[SyncProjectEdit] 🚫 Reintentos agotados para proyecto ${args.projectId}`);
        }
        await ctx.runMutation(internal.data.projects.updateProjectSyncMetadata, {
          projectId: args.projectId,
          corSyncStatus: "error",
          corSyncError: isClientError(error)
            ? `Error de validación COR (no reintentable): ${errorMsg}`
            : `Falló después de ${MAX_RETRY_ATTEMPTS} intentos. Último error: ${errorMsg}`,
          corSyncAttempt: attempt,
        });
      }
    }
  },
});

/**
 * Mutation interna para actualizar metadata de sync de proyecto.
 */
export const updateProjectSyncMetadata = internalMutation({
  args: {
    projectId: v.id("projects"),
    corSyncStatus: v.optional(v.string()),
    corSyncedAt: v.optional(v.number()),
    corSyncAttempt: v.optional(v.number()),
    corSyncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updateData: Record<string, unknown> = {};
    if (args.corSyncStatus !== undefined) updateData.corSyncStatus = args.corSyncStatus;
    if (args.corSyncedAt !== undefined) updateData.corSyncedAt = args.corSyncedAt;
    if (args.corSyncAttempt !== undefined) updateData.corSyncAttempt = args.corSyncAttempt;
    if (args.corSyncError !== undefined) updateData.corSyncError = args.corSyncError;
    // Limpiar error cuando se marca synced
    if (args.corSyncStatus === "synced") {
      updateData.corSyncError = undefined;
      updateData.corSyncAttempt = 0;
    }

    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(args.projectId, updateData);
    }
  },
});

/**
 * Actualiza el estado de publicación de un proyecto.
 * Llamado desde la action de publicación después de crear en COR.
 */
export const updateProjectPublishStatus = internalMutation({
  args: {
    projectId: v.id("projects"),
    corProjectId: v.optional(v.number()),
    corSyncStatus: v.string(),
    corSyncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      corSyncStatus: args.corSyncStatus,
    };

    if (args.corProjectId !== undefined) {
      updates.corProjectId = args.corProjectId;
    }
    if (args.corSyncError !== undefined) {
      updates.corSyncError = args.corSyncError;
    }
    if (args.corSyncStatus === "synced") {
      updates.corSyncedAt = Date.now();
      updates.corSyncError = undefined;
    }

    await ctx.db.patch(args.projectId, updates);
    console.log(`[projects] 🔄 Proyecto ${args.projectId} → ${args.corSyncStatus}`);
  },
});

/**
 * Mutation pública: reintento manual de sincronización de proyecto con COR.
 * Llamada desde la UI cuando el usuario hace clic en "Reintentar" después de un error.
 */
export const retryProjectSync = mutation({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Proyecto no encontrado");

    // Verificar permisos (clientUserAssignments)
    if (project.corClientId) {
      const client = await ctx.db
        .query("corClients")
        .filter((q) => q.eq(q.field("corClientId"), project.corClientId))
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
            `No tienes permisos para reintentar la sincronización de proyectos de este cliente.`
          );
        }
      }
    }

    if (!["error", "retrying"].includes(project.corSyncStatus || "")) {
      throw new Error("El proyecto no está en estado de error para reintentar.");
    }

    if (!project.corProjectId) {
      throw new Error("El proyecto no tiene ID de COR. Debe publicarse primero desde la task.");
    }

    console.log(`[retryProjectSync] 🔄 Reintentando sync de proyecto ${args.projectId}`);
    await ctx.db.patch(args.projectId, {
      corSyncStatus: "syncing",
      corSyncAttempt: 0,
      corSyncError: undefined,
    });

    const allSyncFields = ["name", "brief", "startDate", "endDate", "deliverables", "estimatedTime"];
    await ctx.scheduler.runAfter(0, internal.data.projects.syncProjectEditToCORAction, {
      projectId: args.projectId,
      changedFields: allSyncFields,
      attempt: 0,
    });

    return { success: true, message: "Sincronización reintentada" };
  },
});
