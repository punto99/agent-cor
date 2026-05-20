import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";

export const listByBrand = query({
  args: {
    clientBrandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", args.clientBrandId))
      .collect();
  },
});

export const getByCorProductId = internalQuery({
  args: {
    corProductId: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subBrands")
      .withIndex("by_corProductId", (q) =>
        q.eq("corProductId", args.corProductId),
      )
      .unique();
  },
});

export const getLocalBrandByCorId = internalQuery({
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

export const upsertSubBrand = internalMutation({
  args: {
    clientBrandId: v.id("clientBrands"),
    clientId: v.optional(v.id("corClients")),
    corClientId: v.number(),
    corBrandId: v.number(),
    corProductId: v.number(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("subBrands")
      .withIndex("by_corBrandId_and_corProductId", (q) =>
        q
          .eq("corBrandId", args.corBrandId)
          .eq("corProductId", args.corProductId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        clientBrandId: args.clientBrandId,
        clientId: args.clientId,
        corClientId: args.corClientId,
        name: args.name,
        syncedAt: now,
      });
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("subBrands", {
      clientBrandId: args.clientBrandId,
      clientId: args.clientId,
      corClientId: args.corClientId,
      corBrandId: args.corBrandId,
      corProductId: args.corProductId,
      name: args.name,
      syncedAt: now,
    });

    return { id, created: true };
  },
});
