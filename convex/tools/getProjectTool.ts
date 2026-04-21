// convex/tools/getProjectTool.ts
// Tool para ver los detalles de un proyecto existente
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";

export const getProjectTool = createTool({
  description: `Ver los detalles completos del proyecto asociado a una task/requerimiento.
  Usar esta herramienta cuando el usuario quiera ver, consultar o revisar la informacion del PROYECTO.
  
  El proyecto se encuentra automaticamente por el threadId de la conversacion actual
  o a traves de una task ya creada en esta conversacion.
  
  IMPORTANTE: Usar esta herramienta ANTES de editar un proyecto para conocer los valores actuales.`,
  args: z.object({
    projectId: z.string().optional().describe("ID del proyecto (opcional — se busca automaticamente por thread)"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("\n========================================");
    console.log("[GetProject] CONSULTANDO PROYECTO");
    console.log("========================================");

    try {
      const threadId = ctx.threadId;
      let project: any = null;

      // Estrategia 1: projectId directo
      if (args.projectId) {
        console.log(`[GetProject] Buscando proyecto por ID: ${args.projectId}`);
        project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
          projectId: args.projectId as any,
        });
      }

      // Estrategia 2: buscar por threadId
      if (!project && threadId) {
        console.log(`[GetProject] Buscando proyecto por threadId: ${threadId}`);
        project = await ctx.runQuery(internal.data.projects.getProjectByThread, { threadId });
      }

      // Estrategia 3: buscar task por threadId y luego su proyecto
      if (!project && threadId) {
        console.log(`[GetProject] Buscando task por threadId para encontrar proyecto...`);
        const task = await ctx.runQuery(internal.data.tasks.getTaskByThreadInternal, { threadId });
        if (task?.projectId) {
          project = await ctx.runQuery(internal.data.projects.getProjectInternal, {
            projectId: task.projectId,
          });
        }
      }

      if (!project) {
        return "No se encontró ningún proyecto asociado a esta conversación. ¿Deseas crear un nuevo requerimiento primero?";
      }

      const corInfo = project.corProjectId
        ? `**ID de proyecto COR:** ${project.corProjectId} ✅`
        : "**Estado COR:** Pendiente de sincronización";

      const projectInfo = `
📂 **Detalles del Proyecto**

${corInfo}

**Nombre:** ${project.name || "Sin nombre"}
**Estado:** ${project.status || "Sin estado"}
**Fecha inicio:** ${project.startDate || "No especificada"}
**Fecha fin:** ${project.endDate || "No especificada"}
**Tiempo estimado:** ${project.estimatedTime ? `${project.estimatedTime} horas` : "No especificado"}

**Brief:**
${project.brief || "Sin brief"}

**Cantidad de entregables:**
${project.deliverables ?? "No especificada"}
`;

      console.log("[GetProject] Proyecto encontrado y formateado exitosamente");
      console.log("========================================\n");
      return projectInfo;
    } catch (error) {
      console.error("[GetProject] Error al consultar proyecto:", error);
      return `Error al consultar el proyecto: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
