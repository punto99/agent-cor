// convex/tools/reviewBriefTool.ts
// Tool de validación del brief usando el reviewerAgent (agente supervisor de calidad)
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { reviewerAgent } from "../agents/reviewerAgent";

// Action interna para generar respuesta del reviewer
export const generateReviewerResponse = reviewerAgent.asTextAction({});

// Tool que el briefAgent usa para validar si la información recolectada es suficiente.
// Delega la evaluación al reviewerAgent, que tiene instrucciones detalladas
// para analizar la calidad del brief y responder en formato JSON estructurado.
export const reviewBriefTool = createTool({
  description: `Validar si la informacion recolectada es suficiente para crear el brief.
  Usar esta herramienta ANTES de mostrar el resumen final al usuario.
  Verifica que los campos obligatorios esten completos y evalua la calidad general.`,
  args: z.object({
    requestType: z.string().describe("Tipo de requerimiento recolectado - OBLIGATORIO"),
    brand: z.string().describe("Marca o empresa recolectada - OBLIGATORIO"),
    deadline: z.string().describe("Fecha limite o timeline del proyecto - OBLIGATORIO"),
    deliverables: z.string().describe("Entregables concretos del proyecto - OBLIGATORIO"),
    objective: z.string().optional().describe("Objetivo del proyecto (si se proporciono)"),
    keyMessage: z.string().optional().describe("Mensaje clave (si se proporciono)"),
    kpis: z.string().optional().describe("KPIs (si se proporcionaron)"),
    budget: z.string().optional().describe("Presupuesto (si se proporciono)"),
    approvers: z.string().optional().describe("Aprobadores (si se proporcionaron)"),
    hasFiles: z.boolean().optional().describe("Si el usuario adjunto archivos"),
  }),
  handler: async (ctx, args): Promise<string> => {
    console.log("[ReviewTool] Validando brief con reviewerAgent...");
    
    // Construir prompt con los datos del brief para el agente reviewer
    const briefSummary = [
      `Tipo de requerimiento: ${args.requestType}`,
      `Marca: ${args.brand}`,
      `Deadline/Fecha límite: ${args.deadline}`,
      `Entregables: ${args.deliverables}`,
      `Objetivo: ${args.objective || "No proporcionado"}`,
      `Mensaje clave: ${args.keyMessage || "No proporcionado"}`,
      `KPIs: ${args.kpis || "No proporcionados"}`,
      `Presupuesto: ${args.budget || "No proporcionado"}`,
      `Aprobadores: ${args.approvers || "No proporcionados"}`,
      `Archivos adjuntos: ${args.hasFiles ? "Sí" : "No"}`,
    ].join("\n");
    
    const prompt = `Evalúa el siguiente brief recolectado y responde en el formato JSON especificado en tus instrucciones:\n\n${briefSummary}`;
    
    try {
      // Llamar al reviewerAgent via su action registrada
      const result = await ctx.runAction(
        internal.tools.reviewBriefTool.generateReviewerResponse,
        { prompt }
      );
      console.log("[ReviewTool] ✅ Evaluación del reviewer completada");
      return `EVALUACION DEL SUPERVISOR:\n\n${result.text}`;
    } catch (error) {
      console.error("[ReviewTool] ❌ Error al llamar reviewerAgent:", error);
      // Fallback: si el reviewer falla, hacer validación básica
      const camposObligatoriosCompletos = !!(
        args.requestType &&
        args.brand &&
        args.deadline &&
        args.deliverables
      );
      const sugerencias: string[] = [];
      if (!args.requestType) sugerencias.push("Falta el tipo de requerimiento");
      if (!args.brand) sugerencias.push("Falta la marca");
      if (!args.deadline) sugerencias.push("Falta la fecha límite (deadline)");
      if (!args.deliverables) sugerencias.push("Faltan los entregables (deliverables)");
      const fallback = {
        aprobado: camposObligatoriosCompletos,
        campos_obligatorios_completos: camposObligatoriosCompletos,
        observaciones: [camposObligatoriosCompletos
          ? "Campos obligatorios completos (evaluación de fallback)"
          : "Faltan campos obligatorios"],
        sugerencias,
        confianza: camposObligatoriosCompletos ? 70 : 0,
      };
      return `EVALUACION DEL SUPERVISOR (fallback):\n\n${JSON.stringify(fallback, null, 2)}`;
    }
  },
});
