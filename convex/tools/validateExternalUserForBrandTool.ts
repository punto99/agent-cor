import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export const validateExternalUserForBrandTool = createTool({
  description: `Valida que el usuario externo tenga acceso a una categoría.
  Internamente la categoría es clientBrands. Si la categoría devuelve subBrands, de cara al usuario esas subBrands se llaman marcas.
  Usar antes de crear un brief externo. Puedes validar por clientBrandId exacto o por nombre de categoría.`,
  args: z.object({
    clientBrandId: z.string().optional().describe("ID local de clientBrands si ya fue listado por listAccessibleBrands."),
    brandName: z.string().optional().describe("Nombre de la categoría indicada por el usuario."),
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    if (!threadId) {
      return JSON.stringify({
        authorized: false,
        error: "No se pudo identificar la conversación.",
      });
    }

    const profile = await ctx.runQuery(internal.data.userAccess.getAccessProfileByThread, {
      threadId,
    });

    if (!profile || profile.kind !== "external") {
      return JSON.stringify({
        authorized: false,
        error: "Este flujo solo está disponible para usuarios externos aprobados.",
      });
    }

    const brands = await ctx.runQuery(internal.data.permissions.listAccessibleBrands, {
      userId: profile.userId as any,
    });

    if (brands.length === 0) {
      return JSON.stringify({
        authorized: false,
        error: "No tienes categorías asignadas todavía. Contacta al equipo para que te habiliten el acceso.",
      });
    }

    let matches: any[] = [];

    if (args.clientBrandId) {
      matches = brands.filter((brand: any) => String(brand._id) === args.clientBrandId);
    } else if (args.brandName?.trim()) {
      const requested = normalizeText(args.brandName);
      matches = brands.filter((brand: any) => normalizeText(brand.name) === requested);

      if (matches.length === 0) {
        matches = brands.filter((brand: any) =>
          normalizeText(brand.name).includes(requested) ||
          requested.includes(normalizeText(brand.name)),
        );
      }
    }

    if (matches.length === 0) {
      return JSON.stringify({
        authorized: false,
        error: "No tienes autorización para trabajar con esa categoría, o no pude encontrarla entre tus categorías asignadas.",
        availableCategories: brands.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
        availableBrands: brands.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
      });
    }

    if (matches.length > 1) {
      return JSON.stringify({
        authorized: false,
        error: "Encontré más de una categoría posible. Pídele al usuario que elija una opción exacta.",
        availableCategories: matches.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
        availableBrands: matches.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
      });
    }

    const brand = matches[0];
    const trelloAccess = await ctx.runAction(
      (internal as any).data.trello.validateExternalUserBoardMembership,
      {
        userId: profile.userId as any,
        clientBrandId: brand._id as any,
      },
    );

    if (!trelloAccess.ok) {
      return JSON.stringify({
        authorized: false,
        error: trelloAccess.error,
      });
    }

    const subBrands = await ctx.runQuery(
      internal.data.subBrands.listByBrandInternal,
      { clientBrandId: brand._id as any },
    );

    return JSON.stringify({
      authorized: true,
      clientBrandId: String(brand._id),
      brandName: brand.name,
      categoryName: brand.name,
      corBrandId: brand.corBrandId,
      corClientId: brand.corClientId,
      localClientId: brand.clientId ? String(brand.clientId) : undefined,
      requiresSubBrand: subBrands.length > 0,
      requiresBrand: subBrands.length > 0,
      subBrands: subBrands.map((subBrand: any) => ({
        subBrandId: String(subBrand._id),
        name: subBrand.name,
        corProductId: subBrand.corProductId,
      })),
    });
  },
});
