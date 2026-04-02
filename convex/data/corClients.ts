// convex/data/corClients.ts
// =====================================================
// Queries y mutations para las tablas corClients y clientUserAssignments.
//
// Las actions (syncClientsFromCOR) están en
// convex/data/corClientsActions.ts (requieren "use node" para HTTP a COR).
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
 * Lista todos los clientes disponibles en corClients.
 * Para UI de administración / selección de clientes.
 */
export const listClients = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    return await ctx.db.query("corClients").collect();
  },
});

/**
 * Lista los clientes asignados al usuario autenticado.
 * Usado en UI para mostrar solo los clientes que puede usar.
 */
export const listMyClients = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    // Obtener asignaciones del usuario
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    if (assignments.length === 0) return [];

    // Obtener los clientes asociados
    const clients = await Promise.all(
      assignments.map((a) => ctx.db.get(a.clientId))
    );

    // Filtrar nulls (por si algún cliente fue eliminado)
    return clients.filter(Boolean);
  },
});

/**
 * Obtiene un cliente por su corClientId (ID en COR).
 * Uso interno desde actions.
 */
export const getClientByCorId = internalQuery({
  args: { corClientId: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
      .unique();
  },
});

/**
 * Verifica si un usuario tiene acceso a un cliente.
 * Uso interno (validación en tools del agente).
 */
export const isUserAuthorizedForClient = internalQuery({
  args: {
    clientId: v.id("corClients"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", args.clientId).eq("userId", args.userId)
      )
      .unique();

    return assignment !== null;
  },
});

// ==================== MUTATIONS ====================

/**
 * Upsert un cliente local desde datos de COR.
 * Idempotente: si ya existe (by corClientId), actualiza.
 */
export const upsertClient = internalMutation({
  args: {
    corClientId: v.number(),
    name: v.string(),
    businessName: v.optional(v.string()),
    nameContact: v.optional(v.string()),
    lastNameContact: v.optional(v.string()),
    emailContact: v.optional(v.string()),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        businessName: args.businessName,
        nameContact: args.nameContact,
        lastNameContact: args.lastNameContact,
        emailContact: args.emailContact,
        website: args.website,
        description: args.description,
        phone: args.phone,
        syncedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("corClients", {
      corClientId: args.corClientId,
      name: args.name,
      businessName: args.businessName,
      nameContact: args.nameContact,
      lastNameContact: args.lastNameContact,
      emailContact: args.emailContact,
      website: args.website,
      description: args.description,
      phone: args.phone,
      syncedAt: now,
    });
  },
});

/**
 * Asigna un usuario a un cliente. Idempotente.
 */
export const assignUserToClient = mutation({
  args: {
    clientId: v.id("corClients"),
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    // Verificar que el cliente existe
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new Error("Cliente no encontrado");

    // Verificar que no exista ya la asignación (idempotencia)
    const existing = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", args.clientId).eq("userId", args.targetUserId)
      )
      .unique();

    if (existing) {
      console.log(`[corClients] ℹ️ Asignación ya existe: usuario ${args.targetUserId} → cliente ${client.name}`);
      return existing._id;
    }

    const id = await ctx.db.insert("clientUserAssignments", {
      clientId: args.clientId,
      userId: args.targetUserId,
      assignedAt: Date.now(),
      assignedBy: userId,
    });

    console.log(`[corClients] ✅ Usuario ${args.targetUserId} asignado a cliente ${client.name}`);
    return id;
  },
});

/**
 * Remueve la asignación de un usuario a un cliente.
 */
export const removeUserFromClient = mutation({
  args: {
    clientId: v.id("corClients"),
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("No autenticado");

    const assignment = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", args.clientId).eq("userId", args.targetUserId)
      )
      .unique();

    if (!assignment) {
      console.log(`[corClients] ℹ️ No existe asignación para remover`);
      return;
    }

    await ctx.db.delete(assignment._id);
    console.log(`[corClients] ✅ Asignación removida: usuario ${args.targetUserId} de cliente ${args.clientId}`);
  },
});


