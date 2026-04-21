// convex/tools/editProjectTool.ts
// Tool para editar un proyecto existente en Convex y sincronizar con COR si está publicado.
// Usa scheduleProjectSyncToCOR para unificar el flujo de sync con la UI.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const editProjectTool = createTool({
  description: `Editar el proyecto asociado a una task/requerimiento.
  Usar esta herramienta cuando el usuario quiera modificar informacion del PROYECTO (nombre, brief, fechas, entregables, etc.).
  
  IMPORTANTE — FLUJO OBLIGATORIO ANTES DE EDITAR:
  1. Primero usa "getProject" para ver el proyecto completo actual
  2. Muestra al usuario el proyecto con los cambios propuestos resaltados
  3. Espera confirmación explícita del usuario
  4. Solo entonces usa esta herramienta para aplicar los cambios
  
  Si el proyecto está publicado en COR, los cambios se sincronizarán automáticamente.
  
  NOTA: El proyecto se encuentra automaticamente por el threadId de la conversacion actual.`,
  args: z.object({
    projectId: z.string().optional().describe("ID del proyecto (opcional — se busca automaticamente por thread)"),
    name: z.string().optional().describe("Nuevo nombre del proyecto"),
    brief: z.string().optional().describe("Nuevo brief del proyecto"),
    startDate: z.string().optional().describe("Nueva fecha de inicio (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Nueva fecha de fin / deadline (YYYY-MM-DD)"),
    deliverables: z.number().optional().describe("Nueva cantidad de entregables"),
    estimatedTime: z.number().optional().describe("Nuevo tiempo estimado en horas"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[EditProject] EDITANDO PROYECTO");
    console.log("========================================");
    console.log("[EditProject] Datos recibidos:", JSON.stringify(args, null, 2));

    try {
      const threadId = ctx.threadId;
      let project: any = null;
      let projectId = args.projectId;

      // Obtener el userId del thread actual para verificar permisos
      let currentUserId: string | null = null;
      if (threadId) {
        currentUserId = await ctx.runQuery(internal.data.tasks.getUserIdFromThread, { threadId });
        console.log(`[EditProject] Usuario actual: ${currentUserId}`);
      }

      // ====================================================
      // BUSCAR EL PROYECTO
      // ====================================================

      // Estrategia 1: projectId directo
      if (projectId) {
        console.log(`[EditProject] Buscando proyecto por ID: ${projectId}`);
        project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
          projectId: projectId as any,
        });
      }

      // Estrategia 2: buscar por threadId
      if (!project && threadId) {
        console.log(`[EditProject] Buscando proyecto por threadId: ${threadId}`);
        project = await ctx.runQuery(internal.data.projects.getProjectByThread, { threadId });
        if (project) projectId = project._id;
      }

      // Estrategia 3: buscar task por threadId y luego su proyecto
      if (!project && threadId) {
        console.log(`[EditProject] Buscando task por threadId para encontrar proyecto...`);
        const task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task?.projectId) {
          project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
            projectId: task.projectId,
          });
          if (project) projectId = project._id;
        }
      }

      if (!project || !projectId) {
        return "No se encontró ningún proyecto asociado a esta conversación. ¿Deseas crear un nuevo requerimiento primero?";
      }

      // ====================================================
      // VALIDACIÓN DE PERMISOS (clientUserAssignments)
      // ====================================================
      if (project.corClientId && currentUserId) {
        const client = await ctx.runQuery(internal.data.corClients.getClientByCorId, {
          corClientId: project.corClientId,
        });

        if (client) {
          const isAuthorized = await ctx.runQuery(internal.data.corClients.isUserAuthorizedForClient, {
            clientId: client._id,
            userId: currentUserId as any,
          });

          if (!isAuthorized) {
            return `No tienes permisos para editar proyectos de este cliente.`;
          }
        }
      }

      // ====================================================
      // CONSTRUIR CAMPOS A ACTUALIZAR
      // ====================================================
      const updates: Record<string, string | number | undefined> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.brief !== undefined) updates.brief = args.brief;
      if (args.startDate !== undefined) updates.startDate = args.startDate;
      if (args.endDate !== undefined) updates.endDate = args.endDate;
      if (args.deliverables !== undefined) updates.deliverables = args.deliverables;
      if (args.estimatedTime !== undefined) updates.estimatedTime = args.estimatedTime;

      if (Object.keys(updates).length === 0) {
        const corId = project.corProjectId;

        return `📂 **Proyecto actual${corId ? ` (COR ID: ${corId})` : ""}**

**Nombre:** ${project.name || "Sin nombre"}
**Estado:** ${project.status || "Sin estado"}
**Fecha inicio:** ${project.startDate || "No especificada"}
**Fecha fin:** ${project.endDate || "No especificada"}
**Tiempo estimado:** ${project.estimatedTime ? `${project.estimatedTime} horas` : "No especificado"}

**Brief:**
${project.brief || "Sin brief"}

**Cantidad de entregables:**
${project.deliverables ?? "No especificada"}

¿Qué cambios quieres hacer?`;
      }

      console.log(`[EditProject] Campos a actualizar:`, JSON.stringify(updates, null, 2));

      // ====================================================
      // ACTUALIZAR EN CONVEX
      // ====================================================
      await ctx.runMutation(internal.data.projects.updateProjectInternal, {
        projectId: projectId as any,
        updates,
      });
      console.log(`[EditProject] ✅ Proyecto ${projectId} actualizado en Convex`);

      // ====================================================
      // PROGRAMAR SYNC A COR (flujo unificado)
      // ====================================================
      const changedFields = Object.keys(updates);
      await ctx.runMutation(internal.data.projects.scheduleProjectSyncToCOR, {
        projectId: projectId as any,
        changedFields,
      });

      console.log("========================================\n");

      // ====================================================
      // CONSTRUIR RESPUESTA
      // ====================================================
      const updatedProject = await ctx.runQuery(internal.data.projects.getProjectInternal, {
        projectId: projectId as any,
      });

      const final = updatedProject || project;
      const corId = project.corProjectId;
      const corStatus = corId
        ? `\n🔄 Sincronización con COR (ID: ${corId}) programada automáticamente.`
        : "";

      return `✅ Proyecto actualizado exitosamente!

**Campos actualizados:** ${changedFields.join(", ")}${corStatus}

📂 **Proyecto actualizado:**
**Nombre:** ${final.name || "Sin nombre"}
**Fecha inicio:** ${final.startDate || "No especificada"}
**Fecha fin:** ${final.endDate || "No especificada"}
**Tiempo estimado:** ${final.estimatedTime ? `${final.estimatedTime} horas` : "No especificado"}

**Brief:**
${final.brief || "Sin brief"}

**Cantidad de entregables:**
${final.deliverables ?? "No especificada"}

¿Hay algo más que quieras modificar?`;
    } catch (error) {
      console.error("[EditProject] Error actualizando proyecto:", error);
      return `Error al actualizar el proyecto: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
