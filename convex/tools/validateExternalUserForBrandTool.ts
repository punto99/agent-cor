import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export const validateExternalUserForBrandTool = createTool({
  description: `Valida que el usuario externo tenga acceso a un cliente o categoría.
  Internamente la categoría es clientBrands. Si la categoría devuelve subBrands, de cara al usuario esas subBrands se llaman marcas.
  Usar antes de crear un brief externo. Puedes validar por clientBrandId exacto, nombre de categoría, localClientId, corClientId o nombre de cliente.`,
  args: z.object({
    clientBrandId: z.string().optional().describe("ID local de clientBrands si ya fue listado por listAccessibleBrands."),
    brandName: z.string().optional().describe("Nombre de la categoría indicada por el usuario."),
    localClientId: z.string().optional().describe("ID local de corClients si el cliente listado no tiene categorías."),
    corClientId: z.number().optional().describe("ID COR del cliente si el cliente listado no tiene categorías."),
    clientName: z.string().optional().describe("Nombre del cliente indicado por el usuario."),
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

    const targets = (await ctx.runQuery(
      (internal as any).data.permissions.listAccessibleExternalTargets,
      {
        userId: profile.userId as any,
      },
    )) as any[];

    if (targets.length === 0) {
      return JSON.stringify({
        authorized: false,
        error: "No tienes clientes asignados todavía. Contacta al equipo para que te habiliten el acceso.",
      });
    }

    let matches: any[] = [];
    const allBrands = targets.flatMap((target) =>
      target.categories.map((brand: any) => ({
        ...brand,
        clientName: target.clientName,
        localClientId: target.clientId,
      })),
    );

    if (args.clientBrandId) {
      matches = allBrands.filter((brand: any) => String(brand._id) === args.clientBrandId);
    } else if (args.brandName?.trim()) {
      const requested = normalizeText(args.brandName);
      matches = allBrands.filter((brand: any) => normalizeText(brand.name) === requested);

      if (matches.length === 0) {
        matches = allBrands.filter((brand: any) =>
          normalizeText(brand.name).includes(requested) ||
          requested.includes(normalizeText(brand.name)),
        );
      }
    }

    if (matches.length === 0) {
      let clientMatches: any[] = [];

      if (args.localClientId) {
        clientMatches = targets.filter(
          (target) => String(target.clientId) === args.localClientId,
        );
      } else if (args.corClientId !== undefined) {
        clientMatches = targets.filter(
          (target) => target.corClientId === args.corClientId,
        );
      } else if (args.clientName?.trim()) {
        const requestedClient = normalizeText(args.clientName);
        clientMatches = targets.filter(
          (target) => normalizeText(target.clientName) === requestedClient,
        );

        if (clientMatches.length === 0) {
          clientMatches = targets.filter(
            (target) =>
              normalizeText(target.clientName).includes(requestedClient) ||
              requestedClient.includes(normalizeText(target.clientName)),
          );
        }
      } else if (targets.length === 1 && !targets[0].requiresCategory) {
        clientMatches = targets;
      }

      if (clientMatches.length === 1) {
        const target = clientMatches[0];
        if (target.requiresCategory) {
          return JSON.stringify({
            authorized: false,
            error: "Este cliente requiere elegir una categoría.",
            availableCategories: target.categories.map((brand: any) => ({
              clientBrandId: String(brand._id),
              name: brand.name,
            })),
            availableBrands: target.categories.map((brand: any) => ({
              clientBrandId: String(brand._id),
              name: brand.name,
            })),
          });
        }

        return JSON.stringify({
          authorized: true,
          localClientId: String(target.clientId),
          corClientId: target.corClientId,
          corClientName: target.clientName,
          clientName: target.clientName,
          requiresCategory: false,
          requiresBrand: false,
          requiresSubBrand: false,
          trelloEnabled: false,
        });
      }

      if (clientMatches.length > 1) {
        return JSON.stringify({
          authorized: false,
          error: "Encontré más de un cliente posible. Pídele al usuario que elija una opción exacta.",
          availableClients: clientMatches.map((target) => ({
            localClientId: String(target.clientId),
            corClientId: target.corClientId,
            name: target.clientName,
          })),
        });
      }
    }

    if (matches.length === 0) {
      return JSON.stringify({
        authorized: false,
        error: "No tienes autorización para trabajar con esa opción, o no pude encontrarla entre tus opciones asignadas.",
        availableClients: targets.map((target) => ({
          localClientId: String(target.clientId),
          corClientId: target.corClientId,
          name: target.clientName,
        })),
        availableCategories: allBrands.map((brand: any) => ({
          clientBrandId: String(brand._id),
          name: brand.name,
        })),
        availableBrands: allBrands.map((brand: any) => ({
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
    const trelloEnabled = isTrelloEnabledForCorClientId(brand.corClientId);
    if (trelloEnabled) {
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
      trelloEnabled,
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
