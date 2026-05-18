import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const hasFullClientAccess = internalQuery({
  args: {
    userId: v.id("users"),
    clientId: v.id("corClients"),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", args.clientId).eq("userId", args.userId)
      )
      .collect();

    return assignments.some((assignment) => assignment.brandId === undefined);
  },
});

export const hasBrandAccess = internalQuery({
  args: {
    userId: v.id("users"),
    brandId: v.id("clientBrands"),
  },
  handler: async (ctx, args) => {
    const brand = await ctx.db.get(args.brandId);
    if (!brand?.clientId) return false;

    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_client_and_user", (q) =>
        q.eq("clientId", brand.clientId!).eq("userId", args.userId)
      )
      .collect();

    return assignments.some(
      (assignment) =>
        assignment.brandId === undefined || assignment.brandId === args.brandId,
    );
  },
});

export const listAccessibleBrands = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (assignments.length === 0) return [];

    const brandsById = new Map<string, any>();

    for (const assignment of assignments) {
      if (assignment.brandId) {
        const brand = await ctx.db.get(assignment.brandId);
        if (brand) brandsById.set(brand._id, brand);
        continue;
      }

      const clientBrands = await ctx.db
        .query("clientBrands")
        .withIndex("by_client", (q) => q.eq("clientId", assignment.clientId))
        .collect();
      for (const brand of clientBrands) {
        brandsById.set(brand._id, brand);
      }
    }

    return Array.from(brandsById.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  },
});
