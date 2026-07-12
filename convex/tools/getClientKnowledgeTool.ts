import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

async function userCanAccessClient(ctx: any, args: {
  userId: string;
  kind: "internal" | "external";
  corClientId: number;
}) {
  if (args.kind === "external") {
    const targets = (await ctx.runQuery(
      (internal as any).data.permissions.listAccessibleExternalTargets,
      { userId: args.userId },
    )) as any[];

    return targets.some((target) => target.corClientId === args.corClientId);
  }

  const client = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
    corClientId: args.corClientId,
  });
  if (!client) return false;

  return await ctx.runQuery(internal.data.corClients.isUserAuthorizedForClient, {
    clientId: client._id,
    userId: args.userId as any,
  });
}

export const getClientKnowledgeTool = createTool({
  description: `Consultar el conocimiento contextual de Punto99 y del cliente validado.
  Usar solo cuando el usuario pregunte explicitamente por informacion, lineamientos, tono, esencia o reglas del cliente/agencia.
  Requiere corClientId obtenido previamente con validateUserForClient o validateExternalUserForBrand.
  No uses esta herramienta para agregar automaticamente informacion a la task.`,
  args: z.object({
    corClientId: z
      .number()
      .describe(
        "ID COR del cliente ya validado/autorizado en esta conversacion.",
      ),
  }),
  handler: async (ctx, args): Promise<string> => {
    const threadId = ctx.threadId;
    if (!threadId) {
      return "No se pudo identificar la conversación.";
    }

    const profile = await ctx.runQuery(
      internal.data.userAccess.getAccessProfileByThread,
      { threadId },
    );

    if (!profile) {
      return "No se pudo identificar al usuario de esta conversación.";
    }

    const canAccess = await userCanAccessClient(ctx, {
      userId: profile.userId as any,
      kind: profile.kind,
      corClientId: args.corClientId,
    });

    if (!canAccess) {
      return "No tienes autorización para consultar información de ese cliente.";
    }

    const knowledge = await ctx.runQuery(
      (internal as any).data.clientKnowledge.getForAgent,
      {
        corClientId: args.corClientId,
        audience: profile.kind,
      },
    );

    const sections = [];
    if (knowledge?.agency) {
      sections.push(`# Conocimiento de Punto99\n\n${knowledge.agency}`);
    }
    if (knowledge?.client) {
      sections.push(`# Conocimiento del cliente\n\n${knowledge.client}`);
    }

    if (sections.length === 0) {
      return "No hay conocimiento cargado para Punto99 o para este cliente.";
    }

    return sections.join("\n\n---\n\n");
  },
});
