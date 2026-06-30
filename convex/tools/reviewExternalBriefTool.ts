// convex/tools/reviewExternalBriefTool.ts
// Validacion de briefs para usuarios externos. La fecha de lanzamiento es
// obligatoria para el cliente externo, pero se guarda en la descripcion.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";

const languageModel = google("gemini-3.5-flash");

const externalReviewerSystem = `Eres un supervisor de calidad que revisa briefs de clientes externos.

Tu tarea es determinar si la informacion recolectada es suficiente para guardar un requerimiento externo para revision del equipo interno.

VOCABULARIO:
- El cliente externo ve "fecha de lanzamiento".
- Internamente esa fecha NO se guarda como deadline. Se guarda dentro de la descripcion del requerimiento.

CAMPOS OBLIGATORIOS PARA APROBAR:
- Tipo de requerimiento: debe estar claro que tipo de proyecto es.
- Categoria/marca validada: debe estar claro para que categoria autorizada se creara el requerimiento; si la categoria tiene marcas, debe estar elegida la marca.
- Entregables: debe especificarse que se debe entregar concretamente.
- Fecha de lanzamiento: debe estar indicada por el cliente. Puede ser exacta o aproximada.

REGLA ESPECIAL DE FECHA:
- La fecha de lanzamiento SI es obligatoria para usuarios externos.
- Puede ser exacta o aproximada: acepta valores como "mediados de agosto", "septiembre", "Q4", "antes del evento" o una fecha exacta.
- Si falta launchDate o esta vacia, aprobado DEBE ser false.
- No exijas formato YYYY-MM-DD para aprobar.

INFORMACION OPCIONAL:
- Objetivo, mensaje clave, KPIs, presupuesto, aprobadores, referencias, links, archivos y detalles adicionales.

CRITERIOS:
1. Si falta tipo de requerimiento, categoria/marca requerida, entregables o fecha de lanzamiento, aprobado DEBE ser false.
2. Si la fecha de lanzamiento es aproximada pero clara, aprobado puede ser true.
3. La informacion debe ser clara y especifica, no vaga.
4. Si hay contradicciones, senalalas.
5. Si hay archivos, referencias o links mencionados, verifica que los detalles importantes esten reflejados en la informacion adicional.

Responde solo JSON con este formato:
{
  "aprobado": true/false,
  "campos_obligatorios_completos": true/false,
  "fecha_lanzamiento_presente": true/false,
  "observaciones": ["lista de observaciones"],
  "sugerencias": ["lista de preguntas o clarificaciones sugeridas"],
  "confianza": 0-100
}`;

export const reviewExternalBriefTool = createTool({
  description: `Validar si la informacion recolectada es suficiente para crear un brief externo.
  Usar esta herramienta ANTES de mostrar el resumen final al cliente externo.
  La fecha de lanzamiento es obligatoria, pero puede ser aproximada y no se guarda como deadline.`,
  args: z.object({
    requestType: z
      .string()
      .describe("Tipo de requerimiento recolectado - OBLIGATORIO"),
    brand: z
      .string()
      .describe(
        "Categoria validada y, si aplica, marca elegida por el usuario externo - OBLIGATORIO",
      ),
    launchDate: z
      .string()
      .describe(
        "Fecha de lanzamiento exacta o aproximada indicada por el cliente externo. Obligatoria y guardada en la descripcion, no como deadline.",
      ),
    deliverables: z
      .string()
      .describe("Entregables concretos del proyecto - OBLIGATORIO"),
    objective: z
      .string()
      .optional()
      .describe("Objetivo del proyecto (si se proporciono)"),
    keyMessage: z
      .string()
      .optional()
      .describe("Mensaje clave (si se proporciono)"),
    kpis: z.string().optional().describe("KPIs (si se proporcionaron)"),
    budget: z.string().optional().describe("Presupuesto (si se proporciono)"),
    approvers: z
      .string()
      .optional()
      .describe("Aprobadores (si se proporcionaron)"),
    additionalBriefDetails: z
      .string()
      .optional()
      .describe(
        "Informacion adicional relevante que ira dentro de la descripcion: contexto, restricciones, mandatorios, referencias, links y detalles extraidos de documentos.",
      ),
    hasFiles: z.boolean().optional().describe("Si el usuario adjunto archivos"),
  }),
  handler: async (_ctx, args): Promise<string> => {
    console.log("[ReviewExternalTool] Validando brief externo...");

    const briefSummary = [
      `Tipo de requerimiento: ${args.requestType}`,
      `Categoria/marca: ${args.brand}`,
      `Fecha de lanzamiento: ${args.launchDate}`,
      `Entregables: ${args.deliverables}`,
      `Objetivo: ${args.objective || "No proporcionado"}`,
      `Mensaje clave: ${args.keyMessage || "No proporcionado"}`,
      `KPIs: ${args.kpis || "No proporcionados"}`,
      `Presupuesto: ${args.budget || "No proporcionado"}`,
      `Aprobadores: ${args.approvers || "No proporcionados"}`,
      `Informacion adicional del brief: ${args.additionalBriefDetails || "No proporcionada"}`,
      `Archivos adjuntos: ${args.hasFiles ? "Si" : "No"}`,
    ].join("\n");

    try {
      const result = await generateText({
        model: languageModel,
        system: externalReviewerSystem,
        prompt: `Evalua el siguiente brief externo y responde en el formato JSON especificado:\n\n${briefSummary}`,
      });

      console.log("[ReviewExternalTool] Evaluacion externa completada");
      return `EVALUACION DEL SUPERVISOR EXTERNO:\n\n${result.text}`;
    } catch (error) {
      console.error(
        "[ReviewExternalTool] Error al validar brief externo:",
        error,
      );

      const camposObligatoriosCompletos = !!(
        args.requestType &&
        args.brand &&
        args.deliverables &&
        args.launchDate.trim()
      );
      const sugerencias: string[] = [];
      if (!args.requestType) sugerencias.push("Falta el tipo de requerimiento");
      if (!args.brand) sugerencias.push("Falta la categoria o marca validada");
      if (!args.deliverables)
        sugerencias.push("Faltan los entregables concretos");
      if (!args.launchDate.trim())
        sugerencias.push("Falta la fecha de lanzamiento exacta o aproximada");

      const fallback = {
        aprobado: camposObligatoriosCompletos,
        campos_obligatorios_completos: camposObligatoriosCompletos,
        fecha_lanzamiento_presente: !!args.launchDate.trim(),
        observaciones: [
          camposObligatoriosCompletos
            ? "Campos obligatorios completos para flujo externo"
            : "Faltan campos obligatorios para flujo externo",
        ].filter(Boolean),
        sugerencias,
        confianza: camposObligatoriosCompletos ? 70 : 0,
      };

      return `EVALUACION DEL SUPERVISOR EXTERNO (fallback):\n\n${JSON.stringify(fallback, null, 2)}`;
    }
  },
});
