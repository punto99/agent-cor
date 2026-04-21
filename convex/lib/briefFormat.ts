// convex/lib/briefFormat.ts
// =====================================================
// Utilidades de mapeo entre Convex y COR.
//
// PRINCIPIO: La task de Convex es IDÉNTICA a la task de COR.
// Ambas tienen exactamente los mismos campos:
//
//   title       → título de la task
//   description → todo el brief formateado (tipo, marca, objetivo, etc.)
//   deadline    → fecha límite
//   priority    → 0=Low, 1=Medium, 2=High, 3=Urgent
//   status      → estado de la task
//
// Al sincronizar, cada campo va directo 1:1 sin transformación.
// =====================================================

// ==================== BUILD BRIEF DESCRIPTION ====================

export const STRATEGIC_PRIORITY_VALUES = ["I_U", "I_NU", "NI_U", "NI_NU"] as const;
export type StrategicPriority = typeof STRATEGIC_PRIORITY_VALUES[number];

const STRATEGIC_PRIORITY_COLORS: Record<StrategicPriority, string> = {
  I_U: "#dc2626",   // rojo
  I_NU: "#d97706",  // ámbar
  NI_U: "#2563eb",  // azul
  NI_NU: "#16a34a", // verde
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToParagraphs(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>\n");
}

export function isStrategicPriority(value: string): value is StrategicPriority {
  return STRATEGIC_PRIORITY_VALUES.includes(value as StrategicPriority);
}

export function renderStrategicPriorityHtml(priority: StrategicPriority): string {
  const color = STRATEGIC_PRIORITY_COLORS[priority];
  return `<strong>Prioridad Estratégica:</strong> <span style=\"font-weight:600;color:${color};\">${priority}</span>`;
}

/**
 * Elimina una línea/párrafo previo de Prioridad Estratégica (plain o HTML)
 * para evitar duplicados antes de reinsertar el valor actualizado.
 */
export function removeStrategicPriority(description: string): string {
  const withoutHtmlPriority = description
    .replace(
      /\s*(?:<strong[^>]*>)?\s*Prioridad\s*Estrat[eé]gica\s*:\s*(?:<\/strong>)?\s*(?:<span[^>]*>)?\s*(?:I_U|I_NU|NI_U|NI_NU)\s*(?:<\/span>)?\s*<br\s*\/?>\s*/gi,
      ""
    )
    .replace(
      /<p[^>]*>\s*(?:<strong[^>]*>)?\s*Prioridad\s*Estrat[eé]gica\s*:\s*(?:<\/strong>)?\s*(?:<span[^>]*>)?\s*(?:I_U|I_NU|NI_U|NI_NU)\s*(?:<\/span>)?\s*<\/p>\s*/gi,
      ""
    )
    .replace(
      /(^|\n)\s*(?:<strong[^>]*>)?\s*Prioridad\s*Estrat[eé]gica\s*:\s*(?:<\/strong>)?\s*(?:I_U|I_NU|NI_U|NI_NU)\s*(?=\n|$)/gi,
      "\n"
    )
    .trim();

  return withoutHtmlPriority;
}

/**
 * Convierte texto plano a HTML de párrafos para mantener formato rich text.
 * Si ya parece HTML, lo devuelve igual.
 */
export function ensureHtmlDescription(description: string): string {
  if (/<\/?[a-z][\s\S]*>/i.test(description)) {
    return description;
  }
  return textToParagraphs(description);
}

/**
 * Inserta la Prioridad Estratégica al inicio del description (en HTML).
 */
export function prependStrategicPriority(description: string, priority: StrategicPriority): string {
  const clean = removeStrategicPriority(description);
  const baseHtml = ensureHtmlDescription(clean);
  const priorityHtml = renderStrategicPriorityHtml(priority);
  return baseHtml ? `${priorityHtml}<br>\n${baseHtml}` : priorityHtml;
}

/**
 * Construye el texto de description de la task a partir de los campos
 * individuales del brief. Este texto se guarda tanto en Convex como en COR.
 *
 * IMPORTANTE: Solo incluye campos que NO tienen field dedicado en la task.
 * - deadline → se guarda en task.deadline (NO en description)
 * - deliverables (texto) → se guarda en description
 * - priority → se guarda en task.priority (NO en description)
 * - title → se guarda en task.title (NO en description)
 *
 * El formato es plano y legible para que se vea bien en ambos sistemas.
 */
export function buildBriefDescription(fields: {
  requestType: string;
  brand: string;
  objective?: string;
  keyMessage?: string;
  kpis?: string;
  deadline?: string;       // Ignorado — se guarda en task.deadline
  deliverables?: string;   // Incluido como texto en description
  budget?: string;
  approvers?: string;
  additionalNotes?: string;
  strategicPriority?: string;
}): string {
  const lines: string[] = [];

  if (fields.strategicPriority && isStrategicPriority(fields.strategicPriority)) {
    lines.push(renderStrategicPriorityHtml(fields.strategicPriority));
  }

  lines.push(`<strong>Tipo de requerimiento:</strong> ${escapeHtml(fields.requestType)}`);
  // Marca NO se incluye — se guarda en task.corClientName (field dedicado)
  // deadline NO se incluye — tiene field dedicado
  if (fields.deliverables) {
    lines.push(`<strong>Entregables:</strong> ${escapeHtml(fields.deliverables).replace(/\n/g, "<br>")}`);
  }
  if (fields.objective) lines.push(`<strong>Objetivo:</strong> ${escapeHtml(fields.objective)}`);
  if (fields.keyMessage) lines.push(`<strong>Mensaje clave:</strong> ${escapeHtml(fields.keyMessage)}`);
  if (fields.kpis) lines.push(`<strong>KPIs:</strong> ${escapeHtml(fields.kpis)}`);
  if (fields.budget) lines.push(`<strong>Presupuesto:</strong> ${escapeHtml(fields.budget)}`);
  if (fields.approvers) lines.push(`<strong>Aprobadores:</strong> ${escapeHtml(fields.approvers)}`);
  if (fields.additionalNotes) {
    lines.push(`<strong>Notas adicionales:</strong> ${escapeHtml(fields.additionalNotes).replace(/\n/g, "<br>")}`);
  }

  return lines.join("<br>\n");
}

// ==================== MAPEO DE PRIORIDADES ====================

/** Labels legibles para la prioridad numérica */
export const PRIORITY_LABELS: Record<number, string> = {
  0: "Baja",
  1: "Media",
  2: "Alta",
  3: "Urgente",
};

/**
 * Mapea prioridad textual a valor numérico de COR.
 * COR: 0 = Low, 1 = Medium, 2 = High, 3 = Urgent
 * También acepta el número directamente.
 */
export function mapPriorityToCOR(priority: string | number | undefined): number {
  if (typeof priority === "number") return priority;
  switch (priority?.toLowerCase()) {
    case "baja":
    case "low":
      return 0;
    case "alta":
    case "high":
      return 2;
    case "urgente":
    case "urgent":
      return 3;
    case "media":
    case "medium":
    default:
      return 1;
  }
}

/**
 * Mapea prioridad numérica de COR a texto.
 */
export function mapCORPriorityToConvex(priority: number | undefined): string {
  switch (priority) {
    case 0: return "baja";
    case 2: return "alta";
    case 3: return "urgente";
    case 1:
    default: return "media";
  }
}

// ==================== HASH PARA DETECCIÓN DE CAMBIOS ====================

/**
 * Genera un hash simple de un texto para comparar si cambió.
 * Usa un hash FNV-1a de 32 bits (rápido, sin dependencias externas).
 * Se usa para el campo corDescriptionHash.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Convertir a hex string positivo
  return (hash >>> 0).toString(16).padStart(8, "0");
}
