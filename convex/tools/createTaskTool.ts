// convex/tools/createTaskTool.ts
// Tool principal para crear una task/requerimiento en Convex
// También crea el proyecto local asociado (obligatorio)
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { listMessages } from "@convex-dev/agent";
import { internal, components } from "../_generated/api";
import { isProjectManagementEnabled } from "../integrations/registry";
import { buildBriefDescription } from "../lib/briefFormat";

// SOLO crea en Convex — la publicación en COR/externo se hace desde el Panel de Control
export const createTaskTool = createTool({
  description: `Crear una nueva task/requerimiento en la base de datos. 
  SOLO usar esta herramienta cuando el usuario haya CONFIRMADO explicitamente que toda la informacion esta correcta.
  El usuario debe decir algo como "si", "correcto", "todo esta bien", "conforme", "ok, guardalo", etc.
  NO usar esta herramienta si el usuario quiere modificar algo.
  
  La task se guardará en el sistema. La publicación al sistema de gestión externo (COR) se hará desde el Panel de Control.
  
  IMPORTANTE: Antes de usar esta herramienta, debes haber usado "validateUserForClient" para obtener 
  corUserId, corClientId, corClientName y localClientId. Inclúyelos en la llamada.`,
  args: z.object({
    title: z.string().describe("Titulo breve y descriptivo del proyecto (ej: Campaña de verano Coca-Cola)"),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    brand: z.string().describe("Marca o empresa - OBLIGATORIO"),
    deadline: z.string().describe("Fecha limite del proyecto - OBLIGATORIO (formato YYYY-MM-DD)"),
    deliverables: z.string().describe("Entregables concretos del proyecto - OBLIGATORIO"),
    objective: z.string().optional().describe("Objetivo principal del proyecto"),
    keyMessage: z.string().optional().describe("Mensaje clave a comunicar"),
    kpis: z.string().optional().describe("KPIs o metricas de exito"),
    budget: z.string().optional().describe("Presupuesto disponible"),
    approvers: z.string().optional().describe("Personas que deben aprobar el proyecto"),
    priority: z.number().optional().describe("Prioridad numerica: 0=Baja, 1=Media, 2=Alta, 3=Urgente. Si no se especifica, usar 1 (Media)."),
    corUserId: z.number().optional().describe("COR ID del usuario (obtenido con validateUserForClient)"),
    corClientId: z.number().optional().describe("ID del cliente en COR (obtenido con validateUserForClient)"),
    corClientName: z.string().optional().describe("Nombre del cliente en COR (obtenido con validateUserForClient)"),
    localClientId: z.string().optional().describe("ID local del cliente en Convex (obtenido con validateUserForClient)"),
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
    if (isProjectManagementEnabled()) {
      if (!args.corClientId) {
        return `❌ No se puede crear el requerimiento sin un cliente válido en COR.\n\nAntes de crear el requerimiento, debes usar la herramienta "validateUserForClient" para validar al usuario y al cliente.\nNO crees el requerimiento hasta tener un corClientId válido.`;
      }

      // Obtener userId de Convex
      const userId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
      if (!userId) {
        return "❌ No se pudo identificar al usuario de esta conversación.";
      }

      // Verificar que el usuario existe en COR (cache)
      const corUser = await ctx.runQuery(internal.data.corUsers.getCorUserByUserId, {
        userId: userId as any,
      });
      if (!corUser) {
        return "❌ Tu usuario no está registrado en el sistema de gestión de proyectos (COR). Usa primero la herramienta 'validateUserForClient'.";
      }

      // Verificar cliente local existe
      const localClient = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
        corClientId: args.corClientId,
      });
      if (!localClient) {
        return "❌ El cliente no está registrado localmente. Usa primero la herramienta 'validateUserForClient'.";
      }

      // Verificar autorización usuario → cliente
      const isAuthorized = await ctx.runQuery(internal.data.corClients.isUserAuthorizedForClient, {
        clientId: localClient._id,
        userId: userId as any,
      });
      if (!isAuthorized) {
        return `❌ No tienes autorización para crear briefs para el cliente "${args.corClientName || args.corClientId}". Contacta al administrador.`;
      }
    }

    // 4. Verificar IDEMPOTENCIA: Si ya existe una task para este thread, no crear otra
    const existingTask = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
    
    if (existingTask) {
      console.log(`[CreateTask] ⚠️ Ya existe task para este thread: ${existingTask._id}`);
      return `Ya existe un requerimiento para esta conversación.\n\nID del requerimiento: ${existingTask._id}\nEstado: ${existingTask.status}\n\nSi necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.\nSi quieres modificar el existente, usa la herramienta "editTask".`;
    }

    // Obtener el userId del thread para el campo createdBy
    const userId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
    console.log(`[CreateTask] UserId: ${userId || "no encontrado"}`);

    // ====================================================
    // Clasificar prioridad estratégica (no bloquea la creación si falla)
    // ====================================================
    let strategicPriority: string | undefined;
    try {
      console.log("[CreateTask] 🎯 Clasificando prioridad estratégica...");
      const classification = await ctx.runAction(internal.agents.priorityAgent.classifyPriorityAction, {
        title: args.title,
        requestType: args.requestType,
        brand: args.brand,
        objective: args.objective,
        keyMessage: args.keyMessage,
        kpis: args.kpis,
        deadline: args.deadline,
        budget: args.budget,
        approvers: args.approvers,
      });
      if (classification) {
        strategicPriority = classification;
        console.log(`[CreateTask] ✅ Prioridad estratégica: ${strategicPriority}`);
      }
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudo clasificar prioridad estratégica (continuando):", error);
    }

    // ====================================================
    // Construir description con toda la info del brief
    // ====================================================
    const description = buildBriefDescription({
      requestType: args.requestType,
      brand: args.brand,
      deadline: args.deadline,
      deliverables: args.deliverables,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      budget: args.budget,
      approvers: args.approvers,
      strategicPriority,
    });

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
              const fileInfo = await ctx.runQuery(internal.data.tasks.getFileInfoInternal, { fileId });
              if (fileInfo?.url) {
                fileUrls.push(fileInfo.url);
              }
            } catch {
              // Skip files that can't be resolved
            }
          }
        }
      }
      console.log(`[CreateTask] 📎 URLs de archivos encontradas: ${fileUrls.length}`);
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudieron obtener URLs de archivos (continuando):", error);
    }

    // ====================================================
    // Resolver localClientId
    // ====================================================
    let localClientId: string | undefined = args.localClientId;
    if (!localClientId && args.corClientId) {
      const localClient = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
        corClientId: args.corClientId,
      });
      if (localClient) {
        localClientId = localClient._id;
      }
    }

    // ====================================================
    // CREAR PROYECTO (OBLIGATORIO — antes de la task)
    // ====================================================
    let projectId: string | undefined;
    try {
      console.log("[CreateTask] 📁 Verificando proyecto para este thread...");
      const existingProject = await ctx.runQuery(internal.data.projects.getProjectByThread, { threadId });

      if (existingProject) {
        projectId = existingProject._id;
        console.log(`[CreateTask] ℹ️ Proyecto ya existe: ${projectId}`);
      } else {
        // Obtener corUserId para pmId
        let pmId: number | undefined = args.corUserId;
        if (!pmId && userId) {
          const corUser = await ctx.runQuery(internal.data.corUsers.getCorUserByUserId, {
            userId: userId as any,
          });
          if (corUser) {
            pmId = corUser.corUserId;
          }
        }

        projectId = await ctx.runMutation(internal.data.projects.createProjectInternal, {
          name: args.title, // El nombre del proyecto lo define el LLM siguiendo el prompt de naming
          brief: fileUrls.length > 0 ? fileUrls.join(", ") : undefined,
          startDate: new Date().toISOString().split("T")[0], // Fecha de hoy YYYY-MM-DD
          endDate: args.deadline,
          status: "active",
          pmId,
          deliverables: args.deliverables,
          createdBy: userId ? String(userId) : undefined,
          threadId,
          corClientId: args.corClientId,
          ...(localClientId ? { clientId: localClientId as any } : {}),
        });
        console.log(`[CreateTask] ✅ Proyecto creado: ${projectId}`);
      }
    } catch (error) {
      console.error("[CreateTask] ❌ Error creando proyecto:", error);
      return "❌ Error: No se pudo crear el proyecto asociado. No se puede crear una task sin proyecto.";
    }

    if (!projectId) {
      return "❌ Error: No se pudo crear el proyecto asociado. No se puede crear una task sin proyecto.";
    }

    // ====================================================
    // Crear task SOLO en Convex (sin sincronización con COR)
    // ====================================================
    console.log("[CreateTask] ⏳ Creando task en Convex...");
    
    const taskId = await ctx.runMutation(internal.data.tasks.createTaskInternal, {
      title: args.title,
      description,
      deadline: args.deadline,
      priority: args.priority ?? 1,
      threadId,
      status: "nueva",
      createdBy: userId ? String(userId) : undefined,
      corSyncStatus: "pending",
      corClientId: args.corClientId,
      corClientName: args.corClientName,
      projectId: projectId,
    });

    console.log(`[CreateTask] ✅ Task creada: ${taskId}`);

    // Asociar archivos del thread a la task (en background, sin bloquear)
    try {
      await ctx.runAction(internal.data.tasks.associateFilesToTask, {
        taskId,
        threadId,
        // Sin corTaskId — no hay task en COR todavía
      });
      console.log("[CreateTask] ✅ Archivos asociados");
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudieron asociar archivos (continuando):", error);
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
