// convex/tools/reviewExternalBriefTool.ts
// Validacion de briefs para usuarios externos. La fecha de lanzamiento es
// obligatoria para el cliente externo, pero se guarda en la descripcion.
import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";

const languageModel = google("gemini-3.7-flash");

function getCurrentDateContext(): string {
  const now = new Date();
  const currentDate = now.toLocaleDateString("es-EC", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Guayaquil",
  });

  return `${currentDate} (${now.toISOString().split("T")[0]}, America/Guayaquil)`;
}

const externalReviewerSystem = `Eres un supervisor de calidad que revisa briefs de clientes externos.

Tu tarea es determinar si la informacion recolectada es suficiente para guardar un requerimiento externo para revision del equipo interno.

VOCABULARIO:
- El cliente externo ve "fecha de lanzamiento".
- Internamente esa fecha NO se guarda como deadline. Se guarda dentro de la descripcion del requerimiento.

CAMPOS OBLIGATORIOS PARA APROBAR:
- Tipo de requerimiento: debe estar claro que tipo de proyecto es.
- Cliente validado: debe estar claro para que cliente autorizado se creara el requerimiento.
- Categoria validada: obligatoria solo si requiresCategory es true.
- Marca elegida: obligatoria solo si requiresSubBrand es true.
- Si requiresCategory o requiresSubBrand es false, no rechaces el brief ni pidas ese dato por su ausencia. No uses el nombre del cliente como sustituto de categoria o marca.
- Entregables: debe especificarse que se debe entregar concretamente.
- Fecha de lanzamiento: debe estar indicada por el cliente. Puede ser exacta o aproximada.

REGLA ESPECIAL DE FECHA:
- La fecha de lanzamiento SI es obligatoria para usuarios externos.
- Siempre usa la fecha actual incluida en el prompt para validar que la fecha de lanzamiento sea futura.
- Puede ser exacta o aproximada: acepta valores como "mediados de agosto", "septiembre", "Q4", "antes del evento" o una fecha exacta solo si queda claro que se refieren a una fecha futura.
- Si falta launchDate o esta vacia, aprobado DEBE ser false.
- No exijas formato YYYY-MM-DD para aprobar.
- Si launchDate es una fecha exacta que ya paso o es hoy, aprobado DEBE ser false.
- Si launchDate es aproximada pero ya paso, aprobado DEBE ser false.
- Si no puedes determinar si launchDate es futura, aprobado DEBE ser false y debes sugerir pedir una fecha o referencia mas clara.

INFORMACION OPCIONAL:
- Objetivo, mensaje clave, KPIs, presupuesto, aprobadores, referencias, links, archivos y detalles adicionales.

CRITERIOS:
1. Si falta cliente validado, tipo de requerimiento, categoria/marca requerida segun sus indicadores, entregables o fecha de lanzamiento, aprobado DEBE ser false.
2. Si la fecha de lanzamiento es aproximada pero clara y futura, aprobado puede ser true.
3. La informacion debe ser clara y especifica, no vaga.
4. Si hay contradicciones, senalalas.
5. Si hay archivos, referencias o links mencionados, verifica que los detalles importantes esten reflejados en la informacion adicional.
6. Si el brief incluye un slogan, claim, copy, CTA, disclaimer o texto indicado explicitamente como literal/tal cual/exacto/sin modificar/debe decir/usar este texto, verifica que aparezca copiado literalmente en mensaje clave o informacion adicional. Si fue resumido, corregido o parafraseado, aprobado DEBE ser false.

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
    clientName: z
      .string()
      .describe("Nombre del cliente autorizado tras validateExternalUserForBrand - OBLIGATORIO"),
    requiresCategory: z
      .boolean()
      .describe("Si el cliente validado requiere categoria. Usa requiresCategory de la validacion; si devuelve clientBrandId, es true."),
    requiresSubBrand: z
      .boolean()
      .describe("Indicador requiresSubBrand devuelto por validateExternalUserForBrand. No lo infieras del brief."),
    brand: z
      .string()
      .optional()
      .describe(
        "Nombre de la categoria validada. Obligatorio solo si requiresCategory es true; omitir si no hay categorias.",
      ),
    subBrand: z
      .string()
      .optional()
      .describe("Nombre de la marca elegida entre las subBrands de la categoria validada. Obligatorio solo si requiresSubBrand es true."),
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

    const currentDateContext = getCurrentDateContext();
    const briefSummary = [
      `Fecha actual para validar lanzamiento: ${currentDateContext}`,
      `Tipo de requerimiento: ${args.requestType}`,
      `Cliente validado: ${args.clientName}`,
      `requiresCategory: ${args.requiresCategory}`,
      `Categoria: ${args.brand || "No proporcionada"}`,
      `requiresSubBrand: ${args.requiresSubBrand}`,
      `Marca: ${args.subBrand || "No proporcionada"}`,
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
        args.clientName.trim() &&
        args.requestType.trim() &&
        (!args.requiresCategory || args.brand?.trim()) &&
        (!args.requiresSubBrand || args.subBrand?.trim()) &&
        args.deliverables.trim() &&
        args.launchDate.trim()
      );
      const sugerencias: string[] = [];
      if (!args.clientName.trim()) sugerencias.push("Falta el cliente validado");
      if (!args.requestType.trim()) sugerencias.push("Falta el tipo de requerimiento");
      if (args.requiresCategory && !args.brand?.trim())
        sugerencias.push("Falta la categoria validada");
      if (args.requiresSubBrand && !args.subBrand?.trim())
        sugerencias.push("Falta la marca elegida");
      if (!args.deliverables.trim())
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
