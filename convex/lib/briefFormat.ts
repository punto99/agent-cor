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

/**
 * Construye el texto de description de la task a partir de los campos
 * individuales del brief. Este texto se guarda tanto en Convex como en COR.
 *
 * El formato es plano y legible para que se vea bien en ambos sistemas.
 */
export function buildBriefDescription(fields: {
  requestType: string;
  brand: string;
  objective?: string;
  keyMessage?: string;
  kpis?: string;
  budget?: string;
  approvers?: string;
  additionalNotes?: string;
  strategicPriority?: string;
}): string {
  const lines: string[] = [];

  lines.push(`Tipo de requerimiento: ${fields.requestType}`);
  lines.push(`Marca: ${fields.brand}`);
  if (fields.objective) lines.push(`Objetivo: ${fields.objective}`);
  if (fields.keyMessage) lines.push(`Mensaje clave: ${fields.keyMessage}`);
  if (fields.kpis) lines.push(`KPIs: ${fields.kpis}`);
  if (fields.budget) lines.push(`Presupuesto: ${fields.budget}`);
  if (fields.approvers) lines.push(`Aprobadores: ${fields.approvers}`);
  if (fields.strategicPriority) lines.push(`Prioridad Estratégica: ${fields.strategicPriority}`);
  if (fields.additionalNotes) lines.push(`\nNotas adicionales:\n${fields.additionalNotes}`);

  return lines.join("\n");
}

// ==================== MAPEO DE ESTADOS ====================

/**
 * Estados válidos de COR. Usamos los mismos en Convex.
 * nueva | en_proceso | estancada | finalizada
 */
export const COR_STATUSES = ["nueva", "en_proceso", "estancada", "finalizada"] as const;
export type CORStatus = typeof COR_STATUSES[number];

/**
 * Labels legibles para los estados de COR (para UI)
 */
export const COR_STATUS_LABELS: Record<CORStatus, string> = {
  nueva: "Nueva",
  en_proceso: "En proceso",
  estancada: "Estancada",
  finalizada: "Finalizada",
};

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
