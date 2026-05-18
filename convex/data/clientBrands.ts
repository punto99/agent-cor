import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";

export const listByClient = query({
  args: {
    corClientId: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("clientBrands")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
      .collect();
  },
});

export const getByCorBrandId = internalQuery({
  args: {
    corBrandId: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("clientBrands")
      .withIndex("by_corBrandId", (q) => q.eq("corBrandId", args.corBrandId))
      .unique();
  },
});

export const getLocalClientByCorId = internalQuery({
  args: {
    corClientId: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("corClients")
      .withIndex("by_corClientId", (q) => q.eq("corClientId", args.corClientId))
      .unique();
  },
});

export const upsertClientBrand = internalMutation({
  args: {
    clientId: v.optional(v.id("corClients")),
    corClientId: v.number(),
    corBrandId: v.number(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("clientBrands")
      .withIndex("by_corClientId_and_corBrandId", (q) =>
        q.eq("corClientId", args.corClientId).eq("corBrandId", args.corBrandId)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        clientId: args.clientId,
        name: args.name,
        syncedAt: now,
      });
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("clientBrands", {
      clientId: args.clientId,
      corClientId: args.corClientId,
      corBrandId: args.corBrandId,
      name: args.name,
      syncedAt: now,
    });

    return { id, created: true };
  },
});
