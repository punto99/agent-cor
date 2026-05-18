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
  description: `Valida que el usuario externo tenga acceso a una marca/board.
  Usar antes de crear un brief externo. Puedes validar por clientBrandId exacto o por nombre de marca.`,
  args: z.object({
    clientBrandId: z.string().optional().describe("ID local de clientBrands si ya fue listado por listAccessibleBrands."),
    brandName: z.string().optional().describe("Nombre de la marca indicado por el usuario."),
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
        error: "No tienes marcas asignadas todavía. Contacta al equipo para que te habiliten el acceso.",
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
        error: "No tienes autorización para trabajar con esa marca, o no pude encontrarla entre tus marcas asignadas.",
        availableBrands: brands.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
      });
    }

    if (matches.length > 1) {
      return JSON.stringify({
        authorized: false,
        error: "Encontré más de una marca posible. Pídele al usuario que elija una opción exacta.",
        availableBrands: matches.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
      });
    }

    const brand = matches[0];

    return JSON.stringify({
      authorized: true,
      clientBrandId: String(brand._id),
      brandName: brand.name,
      corBrandId: brand.corBrandId,
      corClientId: brand.corClientId,
      localClientId: brand.clientId ? String(brand.clientId) : undefined,
    });
  },
});
