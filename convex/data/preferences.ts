import { query, mutation } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

// Obtener las preferencias del usuario actual
export const getUserPreferences = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);

    if (userId === null) {
      return null;
    }

    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    // Si no hay preferencias, devolver valores por defecto
    if (!preferences) {
      return {
        userId,
        theme: "light" as const,
        controlPanelView: "cards" as const,
        updatedAt: Date.now(),
      };
    }

    return preferences;
  },
});

// Actualizar la vista preferida del panel de control
export const setControlPanelView = mutation({
  args: {
    view: v.union(v.literal("cards"), v.literal("list")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const existingPreferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    if (existingPreferences) {
      await ctx.db.patch(existingPreferences._id, {
        controlPanelView: args.view,
        updatedAt: Date.now(),
      });
      return existingPreferences._id;
    }

    return await ctx.db.insert("preferences", {
      userId,
      controlPanelView: args.view,
      updatedAt: Date.now(),
    });
  },
});

// Actualizar solo el theme
export const setTheme = mutation({
  args: {
    theme: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }

    const existingPreferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    if (existingPreferences) {
      await ctx.db.patch(existingPreferences._id, {
        theme: args.theme,
        updatedAt: Date.now(),
      });
      return existingPreferences._id;
    } else {
      const id = await ctx.db.insert("preferences", {
        userId,
        theme: args.theme,
        updatedAt: Date.now(),
      });
      return id;
    }
  },
});
