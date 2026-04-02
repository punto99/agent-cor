// convex/tools/reviewBriefTool.ts
// Tool de validación rápida del brief (supervisor inline)
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { reviewerAgent } from "../agents/reviewerAgent";

// Action interna para generar respuesta del reviewer (preservada por backward compat)
export const generateReviewerResponse = reviewerAgent.asTextAction({});

// Tool que el briefAgent usa para validar si la información recolectada es suficiente
// OPTIMIZADO: Validación rápida en línea sin llamar a otro agente
export const reviewBriefTool = createTool({
  description: `Validar rapidamente si la informacion recolectada es suficiente para crear el brief.
  Usar esta herramienta ANTES de mostrar el resumen final al usuario.
  Verifica que los campos obligatorios esten completos.`,
  args: z.object({
    requestType: z.string().describe("Tipo de requerimiento recolectado"),
    brand: z.string().describe("Marca o empresa recolectada"),
    objective: z.string().optional().describe("Objetivo del proyecto (si se proporciono)"),
    keyMessage: z.string().optional().describe("Mensaje clave (si se proporciono)"),
    kpis: z.string().optional().describe("KPIs (si se proporcionaron)"),
    deadline: z.string().optional().describe("Timing o fecha limite (si se proporciono)"),
    budget: z.string().optional().describe("Presupuesto (si se proporciono)"),
    approvers: z.string().optional().describe("Aprobadores (si se proporcionaron)"),
    hasFiles: z.boolean().optional().describe("Si el usuario adjunto archivos"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("[ReviewTool] Validando brief (modo rapido)...");
    
    // OPTIMIZACIÓN: Validación simple en línea sin llamar a otro agente
    const observaciones: string[] = [];
    const sugerencias: string[] = [];
    let confianza = 100;
    
    // Verificar campos obligatorios
    const camposObligatoriosCompletos = !!(args.requestType && args.brand);
    
    if (!camposObligatoriosCompletos) {
      observaciones.push("Faltan campos obligatorios");
      if (!args.requestType) sugerencias.push("Falta el tipo de requerimiento");
      if (!args.brand) sugerencias.push("Falta la marca");
      confianza = 0;
    } else {
      observaciones.push("Campos obligatorios completos");
    }
    
    // Evaluar calidad de la información
    let camposOpcionales = 0;
    if (args.objective) camposOpcionales++;
    if (args.keyMessage) camposOpcionales++;
    if (args.kpis) camposOpcionales++;
    if (args.deadline) camposOpcionales++;
    if (args.budget) camposOpcionales++;
    if (args.approvers) camposOpcionales++;
    if (args.hasFiles) camposOpcionales++;
    
    if (camposOpcionales >= 4) {
      observaciones.push("Informacion muy completa");
      confianza = Math.min(confianza, 95);
    } else if (camposOpcionales >= 2) {
      observaciones.push("Informacion adecuada");
      confianza = Math.min(confianza, 85);
    } else if (camposObligatoriosCompletos) {
      observaciones.push("Informacion basica, podria mejorarse");
      sugerencias.push("Considera solicitar mas detalles como objetivo, timing o presupuesto");
      confianza = Math.min(confianza, 70);
    }
    
    const resultado = {
      aprobado: camposObligatoriosCompletos,
      campos_obligatorios_completos: camposObligatoriosCompletos,
      observaciones,
      sugerencias,
      confianza,
    };
    
    console.log("[ReviewTool] ✅ Validacion completada:", JSON.stringify(resultado));
    
    return `EVALUACION DEL SUPERVISOR:\n\n${JSON.stringify(resultado, null, 2)}`;
  },
});
