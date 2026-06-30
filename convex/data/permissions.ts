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

export const listAccessibleExternalTargets = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("clientUserAssignments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (assignments.length === 0) return [];

    const clientsById = new Map<string, any>();
    const brandsByClientId = new Map<string, Map<string, any>>();
    const fullAccessClientIds = new Set<string>();

    async function ensureClient(clientId: any) {
      const key = String(clientId);
      if (clientsById.has(key)) return clientsById.get(key);
      const client = await ctx.db.get(clientId);
      if (client) clientsById.set(key, client);
      return client;
    }

    for (const assignment of assignments) {
      const client = await ensureClient(assignment.clientId);
      if (!client) continue;

      const clientKey = String(client._id);
      if (!brandsByClientId.has(clientKey)) {
        brandsByClientId.set(clientKey, new Map());
      }

      const targetBrands = brandsByClientId.get(clientKey)!;

      if (assignment.brandId) {
        const brand = await ctx.db.get(assignment.brandId);
        if (brand) targetBrands.set(String(brand._id), brand);
        continue;
      }

      fullAccessClientIds.add(clientKey);

      const clientBrands = await ctx.db
        .query("clientBrands")
        .withIndex("by_client", (q) => q.eq("clientId", assignment.clientId))
        .collect();
      for (const brand of clientBrands) {
        targetBrands.set(String(brand._id), brand);
      }
    }

    return Array.from(clientsById.values())
      .map((client) => {
        const clientKey = String(client._id);
        const brands = Array.from(
          brandsByClientId.get(clientKey)?.values() ?? [],
        ).sort((a, b) => a.name.localeCompare(b.name));

        return {
          clientId: client._id,
          corClientId: client.corClientId,
          clientName: client.name,
          nomenclature: client.nomenclature,
          requiresCategory: brands.length > 0,
          categories: brands,
          hasFullAccess: fullAccessClientIds.has(clientKey),
        };
      })
      .filter((target) => target.categories.length > 0 || target.hasFullAccess)
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  },
});
