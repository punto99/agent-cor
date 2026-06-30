import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { buildBriefDescription } from "../lib/briefFormat";
import { associateFilesHelper } from "../data/tasks";
import { isTrelloEnabledForCorClientId } from "../lib/trelloPolicy";

function getTrelloBoardUrl(preparation: {
  trelloBoardUrl?: string;
  trelloBoardId?: string;
}) {
  if (preparation.trelloBoardUrl) return preparation.trelloBoardUrl;
  if (preparation.trelloBoardId) {
    return `https://trello.com/b/${preparation.trelloBoardId}`;
  }
  return undefined;
}

function inferDeliverablesCount(deliverablesText: string): number {
  const trimmed = deliverablesText.trim();
  if (!trimmed) return 0;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const normalized = trimmed
    .replace(/\r\n/g, "\n")
    .replace(/[•·▪◦●]/g, "\n")
    .replace(/\n\s*\d+[\.)]\s+/g, "\n")
    .replace(/\n\s*[-*]\s+/g, "\n");

  const parts = normalized
    .split(/\n|,|;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.length : 1;
}

export const createExternalTaskTool = createTool({
  description: `Crear un requerimiento externo en Convex para revisión del equipo interno.
  SOLO usar esta herramienta cuando el cliente haya confirmado explícitamente que el resumen está correcto.
  No publica en COR. Solo agenda creación en Trello cuando el cliente está explícitamente habilitado para Trello.
  Vocabulario para hablar con el usuario: clientBrandId = categoría; subBrandId = marca.
  Todo dato relevante que no tenga campo propio debe ir en additionalBriefDetails para quedar guardado dentro de description.`,
  args: z.object({
    title: z
      .string()
      .describe(
        "Título breve y descriptivo del requerimiento, sin prefijo de marca.",
      ),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    clientBrandId: z
      .string()
      .optional()
      .describe(
        "ID local de clientBrands validado con validateExternalUserForBrand. De cara al usuario esto es la categoría. Obligatorio solo cuando el cliente tiene categorías.",
      ),
    localClientId: z
      .string()
      .optional()
      .describe(
        "ID local de corClients validado con validateExternalUserForBrand cuando el cliente no tiene categorías.",
      ),
    corClientId: z
      .number()
      .optional()
      .describe(
        "ID COR del cliente validado con validateExternalUserForBrand cuando el cliente no tiene categorías.",
      ),
    brand: z
      .string()
      .optional()
      .describe(
        "Categoría validada si existe; si el cliente no tiene categorías, puede omitirse.",
      ),
    subBrandId: z
      .string()
      .optional()
      .describe(
        "ID local de subBrands cuando validateExternalUserForBrand indicó que la categoría tiene marcas.",
      ),
    launchDate: z
      .string()
      .describe(
        "Fecha de lanzamiento exacta o aproximada indicada por el cliente externo. Obligatoria y guardada dentro de description, no como deadline.",
      ),
    deliverables: z.string().describe("Entregables concretos - OBLIGATORIO"),
    deliverablesCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Cantidad total de entregables confirmada por el cliente. Debe ser el mismo número mostrado en el resumen final.",
      ),
    objective: z
      .string()
      .optional()
      .describe("Objetivo principal del proyecto"),
    keyMessage: z.string().optional().describe("Mensaje clave a comunicar"),
    kpis: z.string().optional().describe("KPIs o métricas de éxito"),
    budget: z.string().optional().describe("Presupuesto disponible"),
    approvers: z
      .string()
      .optional()
      .describe("Personas que deben aprobar este requerimiento"),
    additionalBriefDetails: z
      .string()
      .optional()
      .describe(
        "Detalles relevantes del brief que no tienen campo propio: contexto, restricciones, mandatorios, referencias, tono, especificaciones, observaciones legales, links importantes y datos extraídos de documentos. Se guarda dentro de description, no como campo separado.",
      ),
    priority: z
      .number()
      .optional()
      .describe("Prioridad numérica: 0=Baja, 1=Media, 2=Alta, 3=Urgente."),
    estimatedTime: z
      .number()
      .optional()
      .describe("Horas totales estimadas para completar el requerimiento."),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[CreateExternalTask] CREANDO TASK EXTERNA (SOLO CONVEX)");
    console.log("========================================");

    const threadId = ctx.threadId;
    if (!threadId) {
      return "Error: No se pudo identificar el thread de la conversación.";
    }

    if (!args.deliverables) {
      return "No se puede crear el requerimiento sin especificar los entregables. Pregunta al cliente qué se debe entregar concretamente.";
    }

    if (!args.launchDate.trim()) {
      return "No se puede crear el requerimiento sin una fecha de lanzamiento exacta o aproximada. Pregunta al cliente por una fecha o referencia aproximada.";
    }

    if (!args.clientBrandId && !args.localClientId && args.corClientId === undefined) {
      return `No se puede crear el requerimiento sin un cliente o categoría validada. Usa primero "validateExternalUserForBrand".`;
    }

    const preparation = await ctx.runQuery(
      internal.data.tasks.validateAndPrepareExternalTask,
      {
        threadId,
        clientBrandId: args.clientBrandId as any,
        localClientId: args.localClientId as any,
        corClientId: args.corClientId,
        subBrandId: args.subBrandId as any,
      },
    );

    if (!preparation.ok) {
      return preparation.error;
    }

    const trelloEnabled =
      Boolean(preparation.clientBrandId) &&
      isTrelloEnabledForCorClientId(preparation.corClientId);
    if (trelloEnabled) {
      const trelloAccess = await ctx.runAction(
        (internal as any).data.trello.validateExternalUserBoardMembership,
        {
          userId: preparation.userId as any,
          clientBrandId: preparation.clientBrandId as any,
        },
      );

      if (!trelloAccess.ok) {
        return `❌ ${trelloAccess.error}`;
      }
    }

    const titlePrefix = preparation.brandName || preparation.corClientName;
    const fullTitle = titlePrefix
      ? `${titlePrefix} - ${args.title}`
      : args.title;
    const description = buildBriefDescription({
      requestType: args.requestType,
      brand: preparation.brandName || preparation.corClientName,
      launchDate: args.launchDate,
      deliverables: args.deliverables,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      budget: args.budget,
      approvers: args.approvers,
      additionalNotes: args.additionalBriefDetails,
    });
    const deliverablesCount =
      args.deliverablesCount ?? inferDeliverablesCount(args.deliverables);

    let fileUrls: string[] = [];
    try {
      const messagesResult = await listMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      });

      for (const msg of messagesResult.page) {
        const msgAny = msg as any;
        if (msgAny.fileIds && Array.isArray(msgAny.fileIds)) {
          for (const fileId of msgAny.fileIds) {
            try {
              const fileInfo = await ctx.runQuery(
                internal.data.tasks.getFileInfoInternal,
                { fileId },
              );
              if (fileInfo?.url) fileUrls.push(fileInfo.url);
            } catch {
              // Ignorar archivos que no se puedan resolver.
            }
          }
        }
      }
    } catch (error) {
      console.log(
        "[CreateExternalTask] No se pudieron obtener URLs de archivos:",
        error,
      );
    }

    let result: { projectId: string; taskId: string };
    try {
      result = await ctx.runMutation(internal.data.tasks.createProjectAndTask, {
        projectName: fullTitle,
        projectBrief: fileUrls.length > 0 ? fileUrls.join(", ") : undefined,
        projectDeliverables: deliverablesCount,
        projectEstimatedTime: args.estimatedTime,
        projectCorClientId: preparation.corClientId,
        projectClientId: preparation.localClientId as any,
        projectCreatedBy: preparation.userId,
        projectSource: "external",
        projectClientBrandId: preparation.clientBrandId as any,
        projectBrandId: preparation.corBrandId,
        projectBrandName: preparation.brandName,
        projectSubBrandId: preparation.subBrandId as any,
        projectProductId: preparation.corProductId,
        projectSubBrandName: preparation.subBrandName,
        taskTitle: fullTitle,
        taskDescription: description,
        taskDeliverablesCount: deliverablesCount,
        taskPriority: args.priority ?? 1,
        taskStatus: "nueva",
        taskCreatedBy: preparation.userId,
        taskClientId: preparation.localClientId as any,
        taskCorClientId: preparation.corClientId,
        taskCorClientName: preparation.corClientName,
        taskSource: "external",
        taskClientBrandId: preparation.clientBrandId as any,
        taskBrandId: preparation.corBrandId,
        taskBrandName: preparation.brandName,
        taskSubBrandId: preparation.subBrandId as any,
        taskProductId: preparation.corProductId,
        taskSubBrandName: preparation.subBrandName,
        threadId,
        existingProjectId: preparation.existingProjectId as any,
        externalTrelloAccessVerified: trelloEnabled ? true : undefined,
      });
    } catch (error) {
      console.error("[CreateExternalTask] Error creando proyecto/task:", error);
      if (error instanceof Error && error.message.startsWith("❌")) {
        return error.message;
      }
      return "Error: No se pudo crear el proyecto y requerimiento asociados.";
    }

    try {
      await ctx.runMutation(
        internal.data.tasks.schedulePriorityClassification,
        {
          taskId: result.taskId as any,
          title: args.title,
          requestType: args.requestType,
          brand: preparation.brandName || preparation.corClientName,
          objective: args.objective,
          keyMessage: args.keyMessage,
          kpis: args.kpis,
          budget: args.budget,
          approvers: args.approvers,
        },
      );
    } catch (error) {
      console.log(
        "[CreateExternalTask] No se pudo programar clasificación de prioridad:",
        error,
      );
    }

    try {
      await associateFilesHelper(ctx, result.taskId, threadId);
    } catch (error) {
      console.log(
        "[CreateExternalTask] No se pudieron asociar archivos:",
        error,
      );
    }

    if (trelloEnabled) {
      try {
        await ctx.runMutation(
          internal.data.trello.scheduleCreateCardForExternalTask,
          {
            taskId: result.taskId as any,
            requestType: args.requestType,
            deliverablesCount,
          },
        );
      } catch (error) {
        console.log(
          "[CreateExternalTask] No se pudo programar creación de card en Trello:",
          error,
        );
      }
    }

    const trelloBoardUrl = trelloEnabled
      ? getTrelloBoardUrl(preparation)
      : undefined;
    const trelloBoardLink = trelloBoardUrl
      ? [
          "",
          "Trello:",
          `- Tablero del requerimiento: [Abrir tablero de Trello](${trelloBoardUrl})`,
        ].join("\n")
      : "";

    return `Listo, el requerimiento quedó guardado para revisión del equipo.

ID del requerimiento: ${result.taskId}
${trelloBoardLink}
El equipo interno lo revisará y continuará el proceso.`;
  },
});
