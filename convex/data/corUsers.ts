// convex/data/corUsers.ts
// =====================================================
// Queries y mutations para la tabla corUsers.
// Vincula un usuario de Convex (authTables) con su perfil en COR.
//
// Las actions (resolveUserInCOR, verifyUserInCOR) están en
// convex/data/corUsersActions.ts (requieren "use node" para HTTP a COR).
// =====================================================

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// ==================== QUERIES ====================

/**
 * Obtiene el registro de COR de un usuario por su userId de Convex.
 * Uso interno (desde actions, callbacks, etc.)
 */
export const getCorUserByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("corUsers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

/**
 * Obtiene name y email de un usuario de authTables.
 * Necesario porque las actions no tienen acceso directo a ctx.db.
 */
export const getUserBasicInfo = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return {
      name: (user as Record<string, unknown>).name as string | undefined,
      email: (user as Record<string, unknown>).email as string | undefined,
    };
  },
});

// ==================== MUTATIONS ====================

/**
 * Inserta o actualiza un registro de corUser.
 * Idempotente: si ya existe para ese userId, actualiza los datos.
 */
export const upsertCorUser = internalMutation({
  args: {
    userId: v.id("users"),
    corUserId: v.number(),
    corFirstName: v.string(),
    corLastName: v.string(),
    corEmail: v.string(),
    corRoleId: v.optional(v.number()),
    corPositionName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("corUsers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    const now = Date.now();

    if (existing) {
      // Actualizar datos (pueden haber cambiado en COR)
      await ctx.db.patch(existing._id, {
        corUserId: args.corUserId,
        corFirstName: args.corFirstName,
        corLastName: args.corLastName,
        corEmail: args.corEmail,
        corRoleId: args.corRoleId,
        corPositionName: args.corPositionName,
        lastVerifiedAt: now,
      });
      console.log(`[corUsers] ✅ Usuario actualizado: ${args.corFirstName} ${args.corLastName} (COR ID: ${args.corUserId})`);
      return existing._id;
    }

    // Insertar nuevo
    const id = await ctx.db.insert("corUsers", {
      userId: args.userId,
      corUserId: args.corUserId,
      corFirstName: args.corFirstName,
      corLastName: args.corLastName,
      corEmail: args.corEmail,
      corRoleId: args.corRoleId,
      corPositionName: args.corPositionName,
      resolvedAt: now,
    });

    console.log(`[corUsers] ✅ Usuario creado: ${args.corFirstName} ${args.corLastName} (COR ID: ${args.corUserId})`);
    return id;
  },
});


