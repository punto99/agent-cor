// convex/tools/createTaskTool.ts
// Tool principal para crear una task/requerimiento en Convex
// También crea el proyecto local asociado (obligatorio)
//
// OPTIMIZACIÓN: Usa funciones consolidadas para minimizar runQuery/runMutation.
// - validateAndPrepareTask: 1 query en vez de ~6 queries separadas
// - createProjectAndTask: 1 mutation en vez de 2 mutations separadas
// - associateFilesHelper: helper TS directo (no runAction en mismo runtime)
// - schedulePriorityClassification: no-bloqueante (via scheduler)
// Ref: https://docs.convex.dev/functions/actions#avoid-await-ctxrunmutation--await-ctxrunquery
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { isProjectManagementEnabled } from "../integrations/registry";
import { buildBriefDescription } from "../lib/briefFormat";
import { associateFilesHelper } from "../data/tasks";

function inferDeliverablesCount(deliverablesText: string): number {
  const trimmed = deliverablesText.trim();
  if (!trimmed) return 0;

  // Si el usuario ya dio un número explícito
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // Contar ítems en formatos comunes (líneas, viñetas, comas, punto y coma)
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

// SOLO crea en Convex — la publicación en COR/externo se hace desde el Panel de Control
export const createTaskTool = createTool({
  description: `Crear una nueva task/requerimiento en la base de datos. 
  SOLO usar esta herramienta cuando el usuario haya CONFIRMADO explicitamente que toda la informacion esta correcta.
  El usuario debe decir algo como "si", "correcto", "todo esta bien", "conforme", "ok, guardalo", etc.
  NO usar esta herramienta si el usuario quiere modificar algo.
  
  La task se guardará en el sistema. La publicación al sistema de gestión externo (COR) se hará desde el Panel de Control.
  
  IMPORTANTE: Antes de usar esta herramienta, debes haber usado "validateUserForClient" para obtener 
  corUserId, corClientId, corClientName y localClientId. Inclúyelos en la llamada.
  
  Los campos se guardan automaticamente en sus fields correspondientes:
  - title, deadline, priority → fields dedicados de la task
  - El sistema antepone la nomenclatura del cliente al title y guarda project/task en mayúsculas.
  - deliverables (texto) → description de la task
  - deliverables (cantidad) → field numérico del proyecto asociado
  - El resto (requestType, brand, objective, keyMessage, kpis, budget, approvers, additionalBriefDetails) → se combinan en el campo description
  - Todo dato relevante que no tenga campo dedicado en COR debe ir en additionalBriefDetails para quedar guardado dentro de description.
  No necesitas preocuparte por la distribucion, el sistema lo maneja automaticamente.`,
  args: z.object({
    title: z
      .string()
      .describe(
        'Nombre general de la task y mes/año de entrega, sin nomenclatura ni cliente. Formato: "{Nombre general} - {Mes Año}" (ej: "Campaña institucional - Junio 2026").',
      ),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    brand: z
      .string()
      .describe(
        "Cliente, categoría o marca indicada por el usuario - OBLIGATORIO",
      ),
    clientBrandId: z
      .string()
      .optional()
      .describe(
        "ID local de clientBrands solo si validateUserForClient lo devolvio literalmente. Si no tienes un ID real, omite este campo; no envies string vacio ni inventes IDs.",
      ),
    subBrand: z
      .string()
      .optional()
      .describe(
        "Marca indicada por el usuario cuando la categoría tiene subBrands.",
      ),
    subBrandId: z
      .string()
      .optional()
      .describe(
        "ID local de subBrands solo si validateUserForClient lo devolvio literalmente. Si no tienes un ID real, omite este campo; no envies string vacio ni inventes IDs.",
      ),
    deadline: z
      .string()
      .describe("Fecha limite del proyecto - OBLIGATORIO (formato YYYY-MM-DD)"),
    deliverables: z
      .string()
      .describe("Entregables concretos del proyecto - OBLIGATORIO"),
    deliverablesCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Cantidad total de entregables confirmada por el usuario. Debe ser el mismo número mostrado en el resumen final.",
      ),
    objective: z
      .string()
      .optional()
      .describe("Objetivo principal del proyecto"),
    keyMessage: z.string().optional().describe("Mensaje clave a comunicar"),
    kpis: z.string().optional().describe("KPIs o metricas de exito"),
    budget: z.string().optional().describe("Presupuesto disponible"),
    approvers: z
      .string()
      .optional()
      .describe("Personas que deben aprobar el proyecto"),
    additionalBriefDetails: z
      .string()
      .optional()
      .describe(
        "Detalles relevantes del brief que no tienen campo propio: contexto, restricciones, mandatorios, referencias, tono, especificaciones, observaciones legales, links importantes y datos extraidos de documentos. Se guarda dentro de description, no como campo separado.",
      ),
    priority: z
      .number()
      .optional()
      .describe(
        "Prioridad numerica: 0=Baja, 1=Media, 2=Alta, 3=Urgente. Si no estas seguro, pon 1 (Media).",
      ),
    corUserId: z
      .number()
      .optional()
      .describe("COR ID del usuario (obtenido con validateUserForClient)"),
    corClientId: z
      .number()
      .optional()
      .describe("ID del cliente en COR (obtenido con validateUserForClient)"),
    corClientName: z
      .string()
      .optional()
      .describe(
        "Nombre del cliente en COR (obtenido con validateUserForClient)",
      ),
    localClientId: z
      .string()
      .optional()
      .describe(
        "ID local del cliente en Convex (obtenido con validateUserForClient)",
      ),
    nomenclature: z
      .string()
      .optional()
      .describe(
        "Abreviatura del cliente (obtenido con validateUserForClient). NO la inventes, solo pasala si validateUserForClient la devolvio.",
      ),
    estimatedTime: z
      .number()
      .optional()
      .describe(
        "Horas totales estimadas para completar el proyecto. Estima basándote en el tipo de requerimiento, los entregables y la complejidad. Si no estás seguro, haz una suposición educada. Este campo ayuda a priorizar y asignar recursos, así que es importante dar tu mejor estimación.",
      ),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[CreateTask] 🚀 CREANDO TASK (SOLO CONVEX)");
    console.log("========================================");

    const threadId = ctx.threadId;

    if (!threadId) {
      console.error("[CreateTask] ERROR: No se encontro threadId");
      return "Error: No se pudo identificar el thread de la conversacion.";
    }

    console.log(`[CreateTask] ThreadId: ${threadId}`);

    // ====================================================
    // VALIDACIONES PROGRAMÁTICAS (no dependen del LLM)
    // ====================================================

    // 1. deadline presente y obligatorio
    if (!args.deadline) {
      return "❌ No se puede crear el requerimiento sin una fecha límite (deadline). Pregunta al usuario cuándo necesita el entregable.";
    }

    // 2. deliverables presente y obligatorio
    if (!args.deliverables) {
      return "❌ No se puede crear el requerimiento sin especificar los entregables. Pregunta al usuario qué se debe entregar concretamente.";
    }

    // 3. Validaciones de integración con COR
    const integrationEnabled = isProjectManagementEnabled();
    if (integrationEnabled && !args.corClientId) {
      return `❌ No se puede crear el requerimiento sin un cliente válido en COR.\n\nAntes de crear el requerimiento, debes usar la herramienta "validateUserForClient" para validar al usuario y al cliente.\nNO crees el requerimiento hasta tener un corClientId válido.`;
    }

    // ====================================================
    // VALIDACIÓN CONSOLIDADA (1 query en vez de ~6)
    // ====================================================
    console.log("[CreateTask] 🔍 Validando y preparando...");
    const preparation = await ctx.runQuery(
      internal.data.tasks.validateAndPrepareTask,
      {
        threadId,
        corClientId: args.corClientId,
        corUserId: args.corUserId,
        clientBrandId: args.clientBrandId,
        requireIntegration: integrationEnabled,
      },
    );

    if (!preparation.ok) {
      return preparation.error;
    }

    const { userId, localClientId, pmId, existingProjectId } = preparation;
    console.log(
      `[CreateTask] ✅ Validación OK — UserId: ${userId || "no encontrado"}`,
    );

    const taxonomy = localClientId
      ? await ctx.runQuery(
          internal.data.subBrands.resolveBrandAndSubBrandForClient,
          {
            clientId: localClientId as any,
            brandName: args.brand,
            clientBrandId: args.clientBrandId,
            subBrandName: args.subBrand,
            subBrandId: args.subBrandId,
          },
        )
      : { ok: true as const, requiresBrand: false };

    if (!taxonomy.ok) {
      const taxonomyAny = taxonomy as any;
      const availableBrands = taxonomyAny.availableBrands
        ? `\n\nCategorías disponibles:\n${taxonomyAny.availableBrands
            .map(
              (brand: any) =>
                `- ${brand.name} (clientBrandId: ${brand.clientBrandId})`,
            )
            .join("\n")}`
        : "";
      const availableSubBrands = taxonomyAny.availableSubBrands
        ? `\n\nMarcas disponibles:\n${taxonomyAny.availableSubBrands
            .map(
              (subBrand: any) =>
                `- ${subBrand.name} (subBrandId: ${subBrand.subBrandId})`,
            )
            .join("\n")}`
        : "";
      return `❌ ${taxonomyAny.error}${availableBrands}${availableSubBrands}`;
    }

    const taxonomyAny = taxonomy as any;
    const resolvedBrand = taxonomyAny.brand;
    const resolvedSubBrand = taxonomyAny.subBrand;

    // ====================================================
    // Prefijo del título: nomenclature > corClientName
    // El agente envía el título SIN prefijo de cliente.
    // El sistema lo antepone automáticamente.
    // ====================================================
    const clientPrefix = (args.nomenclature || args.corClientName || "").trim();
    const titleBase = args.title.trim();
    const fullTitle = (clientPrefix
      ? `${clientPrefix} - ${titleBase}`
      : titleBase
    ).toLocaleUpperCase("es");

    // ====================================================
    // Construir description con toda la info del brief
    // (sin strategicPriority — se añade en background después)
    // ====================================================
    const description = buildBriefDescription({
      requestType: args.requestType,
      brand: resolvedBrand?.name ?? args.brand,
      deadline: args.deadline,
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

    // ====================================================
    // Obtener URLs de archivos del thread para el campo brief del proyecto
    // ====================================================
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
              if (fileInfo?.url) {
                fileUrls.push(fileInfo.url);
              }
            } catch {
              // Skip files that can't be resolved
            }
          }
        }
      }
      console.log(
        `[CreateTask] 📎 URLs de archivos encontradas: ${fileUrls.length}`,
      );
    } catch (error) {
      console.log(
        "[CreateTask] ⚠️ No se pudieron obtener URLs de archivos (continuando):",
        error,
      );
    }

    // ====================================================
    // CREAR PROYECTO + TASK ATÓMICAMENTE (1 mutation en vez de 2)
    // ====================================================
    console.log("[CreateTask] ⏳ Creando proyecto y task...");
    let result: { projectId: string; taskId: string };
    try {
      result = await ctx.runMutation(internal.data.tasks.createProjectAndTask, {
        // Project
        projectName: fullTitle,
        projectBrief: fileUrls.length > 0 ? fileUrls.join(", ") : undefined,
        projectEndDate: args.deadline,
        projectDeliverables: deliverablesCount,
        projectEstimatedTime: args.estimatedTime,
        projectPmId: pmId,
        projectCorClientId: args.corClientId,
        projectClientId: localClientId as any,
        projectCreatedBy: userId,
        projectClientBrandId: resolvedBrand?._id as any,
        projectBrandId: resolvedBrand?.corBrandId,
        projectBrandName: resolvedBrand?.name,
        projectSubBrandId: resolvedSubBrand?._id as any,
        projectProductId: resolvedSubBrand?.corProductId,
        projectSubBrandName: resolvedSubBrand?.name,
        // Task
        taskTitle: fullTitle,
        taskDescription: description,
        taskDeadline: args.deadline,
        taskDeliverablesCount: deliverablesCount,
        taskPriority: args.priority ?? 1,
        taskStatus: "nueva",
        taskCreatedBy: userId,
        taskClientId: localClientId as any,
        taskCorClientId: args.corClientId,
        taskCorClientName: args.corClientName,
        taskClientBrandId: resolvedBrand?._id as any,
        taskBrandId: resolvedBrand?.corBrandId,
        taskBrandName: resolvedBrand?.name,
        taskSubBrandId: resolvedSubBrand?._id as any,
        taskProductId: resolvedSubBrand?.corProductId,
        taskSubBrandName: resolvedSubBrand?.name,
        // Shared
        threadId,
        existingProjectId: existingProjectId as any,
      });
    } catch (error) {
      console.error("[CreateTask] ❌ Error creando proyecto/task:", error);
      if (error instanceof Error && error.message.startsWith("❌")) {
        return error.message;
      }
      return "❌ Error: No se pudo crear el proyecto y task asociados.";
    }

    const { projectId, taskId } = result;
    console.log(`[CreateTask] ✅ Proyecto: ${projectId}, Task: ${taskId}`);

    // ====================================================
    // BACKGROUND: Clasificar prioridad estratégica (no-bloqueante)
    // Se ejecuta via scheduler — no bloquea la respuesta al usuario
    // ====================================================
    try {
      await ctx.runMutation(
        internal.data.tasks.schedulePriorityClassification,
        {
          taskId: taskId as any,
          title: args.title,
          requestType: args.requestType,
          brand: args.brand,
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
        "[CreateTask] ⚠️ No se pudo programar clasificación de prioridad (continuando):",
        error,
      );
    }

    // ====================================================
    // Asociar archivos del thread a la task (helper directo, sin runAction)
    // ====================================================
    try {
      await associateFilesHelper(ctx, taskId, threadId);
      console.log("[CreateTask] ✅ Archivos asociados");
    } catch (error) {
      console.log(
        "[CreateTask] ⚠️ No se pudieron asociar archivos (continuando):",
        error,
      );
    }

    console.log("\n========================================");
    console.log("[CreateTask] 🏁 TASK CREADA EXITOSAMENTE");
    console.log(`[CreateTask] Task ID: ${taskId}`);
    console.log(`[CreateTask] Project ID: ${projectId}`);
    console.log("========================================\n");

    return `Listo, requerimiento guardado correctamente.

**ID del requerimiento:** ${taskId}
**Proyecto asociado:** ${projectId}

Puedes revisarlo y publicarlo al sistema de gestión (COR) desde el Panel de Control: /workspace/control-panel

IMPORTANTE PARA EL AGENTE: En tu respuesta al usuario DEBES incluir este link exacto en formato markdown: [Panel de Control](/workspace/control-panel) — el usuario necesita poder hacer clic para ir directamente.`;
  },
});
