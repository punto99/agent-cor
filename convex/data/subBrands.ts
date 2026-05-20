import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

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

export const listByBrandInternal = internalQuery({
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

export const listBrandsWithSubBrandsForClient = internalQuery({
  args: {
    clientId: v.id("corClients"),
  },
  handler: async (ctx, args) => {
    const brands = await ctx.db
      .query("clientBrands")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .collect();

    const result = [];
    for (const brand of brands) {
      const subBrands = await ctx.db
        .query("subBrands")
        .withIndex("by_brand", (q) => q.eq("clientBrandId", brand._id))
        .collect();
      result.push({
        ...brand,
        subBrands: subBrands.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const resolveBrandAndSubBrandForClient = internalQuery({
  args: {
    clientId: v.id("corClients"),
    brandName: v.optional(v.string()),
    clientBrandId: v.optional(v.id("clientBrands")),
    subBrandName: v.optional(v.string()),
    subBrandId: v.optional(v.id("subBrands")),
  },
  handler: async (ctx, args) => {
    const brands = await ctx.db
      .query("clientBrands")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .collect();

    if (brands.length === 0) {
      return {
        ok: true as const,
        requiresBrand: false,
      };
    }

    let brand =
      args.clientBrandId !== undefined ? await ctx.db.get(args.clientBrandId) : null;

    if (!brand && args.brandName?.trim()) {
      const requestedBrand = normalizeText(args.brandName);
      const exactMatches = brands.filter(
        (candidate) => normalizeText(candidate.name) === requestedBrand,
      );
      const fuzzyMatches =
        exactMatches.length > 0
          ? exactMatches
          : brands.filter((candidate) => {
              const normalized = normalizeText(candidate.name);
              return (
                normalized.includes(requestedBrand) ||
                requestedBrand.includes(normalized)
              );
            });

      if (fuzzyMatches.length === 1) {
        brand = fuzzyMatches[0];
      } else if (fuzzyMatches.length > 1) {
        return {
          ok: false as const,
          error:
            "Hay más de una categoría posible. El usuario debe elegir una categoría exacta.",
          requiresBrand: true,
          availableBrands: fuzzyMatches.map((candidate) => ({
            clientBrandId: String(candidate._id),
            name: candidate.name,
          })),
        };
      }
    }

    if (!brand || brand.clientId !== args.clientId) {
      return {
        ok: false as const,
        error:
          "Este cliente tiene categorías configuradas. Debes validar una categoría exacta antes de crear el requerimiento.",
        requiresBrand: true,
        availableBrands: brands.map((candidate) => ({
          clientBrandId: String(candidate._id),
          name: candidate.name,
        })),
      };
    }

    const subBrands = await ctx.db
      .query("subBrands")
      .withIndex("by_brand", (q) => q.eq("clientBrandId", brand!._id))
      .collect();

    if (subBrands.length === 0) {
      return {
        ok: true as const,
        requiresBrand: true,
        requiresSubBrand: false,
        brand,
      };
    }

    let subBrand =
      args.subBrandId !== undefined ? await ctx.db.get(args.subBrandId) : null;

    if (!subBrand && args.subBrandName?.trim()) {
      const requestedSubBrand = normalizeText(args.subBrandName);
      const exactMatches = subBrands.filter(
        (candidate) => normalizeText(candidate.name) === requestedSubBrand,
      );
      const fuzzyMatches =
        exactMatches.length > 0
          ? exactMatches
          : subBrands.filter((candidate) => {
              const normalized = normalizeText(candidate.name);
              return (
                normalized.includes(requestedSubBrand) ||
                requestedSubBrand.includes(normalized)
              );
            });

      if (fuzzyMatches.length === 1) {
        subBrand = fuzzyMatches[0];
      } else if (fuzzyMatches.length > 1) {
        return {
          ok: false as const,
          error:
            "Hay más de una marca posible. El usuario debe elegir una opción exacta.",
          requiresBrand: true,
          requiresSubBrand: true,
          brand,
          availableSubBrands: fuzzyMatches.map((candidate) => ({
            subBrandId: String(candidate._id),
            name: candidate.name,
            corProductId: candidate.corProductId,
          })),
        };
      }
    }

    if (!subBrand || subBrand.clientBrandId !== brand._id) {
      return {
        ok: false as const,
        error:
          `La categoría "${brand.name}" tiene marcas configuradas. Debes elegir una marca antes de crear el requerimiento.`,
        requiresBrand: true,
        requiresSubBrand: true,
        brand,
        availableSubBrands: subBrands.map((candidate) => ({
          subBrandId: String(candidate._id),
          name: candidate.name,
          corProductId: candidate.corProductId,
        })),
      };
    }

    return {
      ok: true as const,
      requiresBrand: true,
      requiresSubBrand: true,
      brand,
      subBrand,
    };
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
