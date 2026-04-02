// convex/tools/createTaskTool.ts
// Tool principal para crear una task/requerimiento en Convex
// También crea el proyecto local asociado
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { isProjectManagementEnabled } from "../integrations/registry";
import { buildBriefDescription } from "../lib/briefFormat";

// SOLO crea en Convex — la publicación en COR/externo se hace desde el Panel de Control
export const createTaskTool = createTool({
  description: `Crear una nueva task/requerimiento en la base de datos. 
  SOLO usar esta herramienta cuando el usuario haya CONFIRMADO explicitamente que toda la informacion esta correcta.
  El usuario debe decir algo como "si", "correcto", "todo esta bien", "conforme", "ok, guardalo", etc.
  NO usar esta herramienta si el usuario quiere modificar algo.
  
  La task se guardará en el sistema. La publicación al sistema de gestión externo (COR) se hará desde el Panel de Control.
  
  Si previamente usaste searchClientInCOR y encontraste un cliente, incluye corClientId y corClientName.`,
  args: z.object({
    title: z.string().describe("Titulo breve y descriptivo del proyecto (ej: Campaña de verano Coca-Cola)"),
    requestType: z.string().describe("Tipo de requerimiento - OBLIGATORIO"),
    brand: z.string().describe("Marca o empresa - OBLIGATORIO"),
    objective: z.string().optional().describe("Objetivo principal del proyecto"),
    keyMessage: z.string().optional().describe("Mensaje clave a comunicar"),
    kpis: z.string().optional().describe("KPIs o metricas de exito"),
    deadline: z.string().optional().describe("Fecha limite o timeline del proyecto"),
    budget: z.string().optional().describe("Presupuesto disponible"),
    approvers: z.string().optional().describe("Personas que deben aprobar el proyecto"),
    priority: z.number().optional().describe("Prioridad numerica: 0=Baja, 1=Media, 2=Alta, 3=Urgente. Si no se especifica, usar 1 (Media)."),
    corClientId: z.number().optional().describe("ID del cliente en COR (obtenido con searchClientInCOR)"),
    corClientName: z.string().optional().describe("Nombre del cliente en COR (obtenido con searchClientInCOR)"),
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

    // Verificar que el cliente exista en COR si la integración está habilitada
    if (isProjectManagementEnabled() && !args.corClientId) {
      console.log("[CreateTask] ❌ BLOQUEADO: Integración habilitada pero no se proporcionó corClientId");
      return `❌ No se puede crear el requerimiento sin un cliente válido en el sistema de gestión de proyectos (COR).

Antes de crear el requerimiento, debes buscar y validar el cliente usando la herramienta searchClientInCOR.
Si el cliente no existe en COR, pide al usuario que proporcione un nombre de cliente que sí esté registrado.

NO crees el requerimiento hasta tener un corClientId válido.`;
    }

    // Verificar IDEMPOTENCIA: Si ya existe una task para este thread, no crear otra
    const existingTask = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
    
    if (existingTask) {
      console.log(`[CreateTask] ⚠️ Ya existe task para este thread: ${existingTask._id}`);
      
      return `Ya existe un requerimiento para esta conversación.

ID del requerimiento: ${existingTask._id}
Estado: ${existingTask.status}

Si necesitas crear un nuevo requerimiento, por favor inicia una nueva conversación.`;
    }

    // Obtener el userId del thread para el campo createdBy
    const userId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
    console.log(`[CreateTask] UserId: ${userId || "no encontrado"}`);

    // Clasificar prioridad estratégica (no bloquea la creación si falla)
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

    // Construir description con toda la info del brief
    const description = buildBriefDescription({
      requestType: args.requestType,
      brand: args.brand,
      objective: args.objective,
      keyMessage: args.keyMessage,
      kpis: args.kpis,
      budget: args.budget,
      approvers: args.approvers,
      strategicPriority,
    });

    // Crear PROYECTO local en Convex (si no existe para este thread)
    let projectId: string | undefined;
    try {
      console.log("[CreateTask] 📁 Verificando proyecto para este thread...");
      const existingProject = await ctx.runQuery(internal.data.projects.getProjectByThread, { threadId });

      if (existingProject) {
        projectId = existingProject._id;
        console.log(`[CreateTask] ℹ️ Proyecto ya existe: ${projectId}`);
      } else {
        // Resolver clientId local (si existe en corClients)
        let localClientId: string | undefined;
        if (args.corClientId) {
          const localClient = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
            corClientId: args.corClientId,
          });
          if (localClient) {
            localClientId = localClient._id;
          }
        }

        const projectName = `${args.corClientName || "Sin cliente"} - ${args.title}`;
        projectId = await ctx.runMutation(internal.data.projects.createProjectInternal, {
          name: projectName,
          brief: description,
          endDate: args.deadline,
          status: "active",
          createdBy: userId ? String(userId) : undefined,
          threadId,
          corClientId: args.corClientId,
          ...(localClientId ? { clientId: localClientId as any } : {}),
        });
        console.log(`[CreateTask] ✅ Proyecto creado: ${projectId}`);
      }
    } catch (error) {
      console.log("[CreateTask] ⚠️ No se pudo crear proyecto (continuando sin proyecto):", error);
    }

    // Crear task SOLO en Convex (sin sincronización con COR)
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
    console.log("========================================\n");

    return `Listo, requerimiento guardado correctamente.

**ID del requerimiento:** ${taskId}

Puedes revisarlo y publicarlo al sistema de gestión (COR) desde el Panel de Control: /workspace/control-panel

IMPORTANTE PARA EL AGENTE: En tu respuesta al usuario DEBES incluir este link exacto en formato markdown: [Panel de Control](/workspace/control-panel) — el usuario necesita poder hacer clic para ir directamente.`;
  },
});
