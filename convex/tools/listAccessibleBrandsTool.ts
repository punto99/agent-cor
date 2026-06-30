import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const listAccessibleBrandsTool = createTool({
  description: `Lista los clientes, categorías y marcas a los que el usuario externo tiene acceso.
  Internamente las categorías son clientBrands. Si una categoría tiene subBrands, de cara al usuario esas subBrands se llaman marcas.
  Usar después de entender el requerimiento para recomendar dónde guardarlo, o cuando el usuario pregunte con qué clientes/categorías/marcas puede trabajar. No usar como primera pregunta de la conversación.`,
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

    const targets = await ctx.runQuery(
      (internal as any).data.permissions.listAccessibleExternalTargets,
      {
        userId: profile.userId as any,
      },
    );

    if (targets.length === 0) {
      return "No tienes clientes asignados todavía. Contacta al equipo para que te habiliten el acceso.";
    }

    const groups: string[] = [];

    for (const target of targets as any[]) {
      const clientLine = `Cliente: ${target.clientName} (localClientId: ${target.clientId}, corClientId: ${target.corClientId})`;

      if (!target.requiresCategory) {
        groups.push(clientLine);
        continue;
      }

      const categoryLines: string[] = [];
      for (const [index, brand] of target.categories.entries()) {
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

        categoryLines.push(
          `${index + 1}. ${brand.name} (clientBrandId: ${brand._id}, corBrandId: ${brand.corBrandId}, corClientId: ${brand.corClientId})${subBrandText}`,
        );
      }

      groups.push(`${clientLine}\nCategorías disponibles:\n${categoryLines.join("\n")}`);
    }

    return groups.join("\n\n");
  },
});
