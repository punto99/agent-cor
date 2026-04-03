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
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

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
    deliverables: v.optional(v.string()),
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
      corSyncStatus: "pending",
    });

    console.log(`[projects] ✅ Proyecto creado: "${args.name}" (ID: ${projectId})`);
    return projectId;
  },
});

/**
 * Actualiza campos de un proyecto existente.
 * Usado desde el Panel de Control para edición pre-publicación.
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
    deliverables: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Proyecto no encontrado");

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
