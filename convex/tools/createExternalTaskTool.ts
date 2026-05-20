import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { buildBriefDescription } from "../lib/briefFormat";
import { associateFilesHelper } from "../data/tasks";

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
  No publica en COR. Para usuarios externos, el sistema también agenda la creación de una card en Trello.
  Vocabulario para hablar con el usuario: clientBrandId = categoría; subBrandId = marca.`,
  args: z.object({
    title: z
      .string()
      .describe(
        "Título breve y descriptivo del requerimiento, sin prefijo de marca.",
      ),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    clientBrandId: z
      .string()
      .describe(
        "ID local de clientBrands validado con validateExternalUserForBrand. De cara al usuario esto es la categoría - OBLIGATORIO",
      ),
    brand: z.string().describe("Categoría validada - OBLIGATORIO"),
    subBrandId: z
      .string()
      .optional()
      .describe(
        "ID local de subBrands cuando validateExternalUserForBrand indicó que la categoría tiene marcas.",
      ),
    deadline: z
      .string()
      .describe("Fecha límite - OBLIGATORIO (formato YYYY-MM-DD)"),
    deliverables: z.string().describe("Entregables concretos - OBLIGATORIO"),
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

    if (!args.deadline) {
      return "No se puede crear el requerimiento sin una fecha límite. Pregunta al cliente cuándo necesita el entregable.";
    }

    if (!args.deliverables) {
      return "No se puede crear el requerimiento sin especificar los entregables. Pregunta al cliente qué se debe entregar concretamente.";
    }

    if (!args.clientBrandId) {
      return `No se puede crear el requerimiento sin una categoría validada. Usa primero "validateExternalUserForBrand".`;
    }

    const preparation = await ctx.runQuery(
      internal.data.tasks.validateAndPrepareExternalTask,
      {
        threadId,
        clientBrandId: args.clientBrandId as any,
        subBrandId: args.subBrandId as any,
      },
    );

    if (!preparation.ok) {
      return preparation.error;
    }

    const fullTitle = `${preparation.brandName} - ${args.title}`;
    const description = buildBriefDescription({
      requestType: args.requestType,
      brand: preparation.brandName,
      deadline: args.deadline,
      deliverables: args.deliverables,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      budget: args.budget,
      approvers: args.approvers,
    });
    const deliverablesCount = inferDeliverablesCount(args.deliverables);

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
        projectEndDate: args.deadline,
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
        taskDeadline: args.deadline,
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
          brand: preparation.brandName,
          objective: args.objective,
          keyMessage: args.keyMessage,
          kpis: args.kpis,
          deadline: args.deadline,
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

    return `Listo, el requerimiento quedó guardado para revisión del equipo.

ID del requerimiento: ${result.taskId}
Proyecto asociado: ${result.projectId}

El equipo interno lo revisará y continuará el proceso.`;
  },
});
