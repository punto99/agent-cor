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

    const clientGroups = new Map<
      string,
      { clientName: string; lines: string[] }
    >();

    for (const brand of brands as any[]) {
      const client = brand.clientId
        ? await ctx.runQuery(internal.data.corClients.getClientById, {
            clientId: brand.clientId as any,
          })
        : null;
      const clientKey = brand.clientId
        ? String(brand.clientId)
        : `cor:${brand.corClientId}`;
      const clientName = client?.name ?? `Cliente ${brand.corClientId}`;

      if (!clientGroups.has(clientKey)) {
        clientGroups.set(clientKey, { clientName, lines: [] });
      }

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
      clientGroups.get(clientKey)!.lines.push(
        `${clientGroups.get(clientKey)!.lines.length + 1}. ${brand.name} (clientBrandId: ${brand._id}, corBrandId: ${brand.corBrandId}, corClientId: ${brand.corClientId})${subBrandText}`,
      );
    }

    const groups = Array.from(clientGroups.values());
    if (groups.length === 1) {
      const group = groups[0];
      return `Cliente: ${group.clientName}\n\nCategorías disponibles para este usuario:\n${group.lines.join("\n")}`;
    }

    return groups
      .map(
        (group) =>
          `Cliente: ${group.clientName}\nCategorías disponibles:\n${group.lines.join("\n")}`,
      )
      .join("\n\n");
  },
});
