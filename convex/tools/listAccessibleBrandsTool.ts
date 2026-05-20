import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const listAccessibleBrandsTool = createTool({
  description: `Lista las categorías a las que el usuario externo tiene acceso.
  Internamente son clientBrands. Si una categoría tiene subBrands, de cara al usuario esas subBrands se llaman marcas.
  Usar al inicio de la conversación o cuando el usuario pregunte con qué categorías/marcas puede trabajar.`,
  args: z.object({}),
  handler: async (ctx): Promise<string> => {
    const threadId = ctx.threadId;
    if (!threadId) {
      return "No se pudo identificar la conversación.";
    }

    const profile = await ctx.runQuery(internal.data.userAccess.getAccessProfileByThread, {
      threadId,
    });

    if (!profile || profile.kind !== "external") {
      return "Esta herramienta solo está disponible para usuarios externos aprobados.";
    }

    const brands = await ctx.runQuery(internal.data.permissions.listAccessibleBrands, {
      userId: profile.userId as any,
    });

    if (brands.length === 0) {
      return "No tienes categorías asignadas todavía. Contacta al equipo para que te habiliten el acceso.";
    }

    const lines = [];
    for (let index = 0; index < brands.length; index += 1) {
      const brand = brands[index] as any;
      const subBrands = await ctx.runQuery(
        internal.data.subBrands.listByBrandInternal,
        { clientBrandId: brand._id as any },
      );
      const subBrandText =
        subBrands.length > 0
          ? `\n   Marcas disponibles: ${subBrands
              .map(
                (subBrand: any) =>
                  `${subBrand.name} (subBrandId: ${subBrand._id}, corProductId: ${subBrand.corProductId})`,
              )
              .join("; ")}`
          : "";
      lines.push(
        `${index + 1}. ${brand.name} (clientBrandId: ${brand._id}, corBrandId: ${brand.corBrandId}, corClientId: ${brand.corClientId})${subBrandText}`,
      );
    }

    return `Categorías disponibles para este usuario:\n${lines.join("\n")}`;
  },
});
