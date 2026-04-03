import { Id } from "@/convex/_generated/dataModel";

// Tipos compartidos para TaskPanel
export type Task = {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;    // Contiene toda la info del brief formateada
  deadline?: string;
  priority?: number;       // 0=Low, 1=Medium, 2=High, 3=Urgent
  status: string;
  threadId: string;
  createdBy?: string;
};

export type MessagePart = {
  type: "text" | "file";
  text?: string;
  url?: string;
};

export type EvaluationMessage = {
  key: string;
  role: "user" | "assistant";
  content: string | MessagePart[];
  text?: string;
  agentName?: string;
  status?: string;
};

export type SelectedFile = {
  base64: string;
  name: string;
  type: string;
};

// Utilidades
export const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const getStatusColor = (status: string) => {
  const colors: Record<string, string> = {
    nueva:
      "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    en_proceso:
      "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    estancada:
      "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
    finalizada:
      "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
  };
  return colors[status] || "bg-muted text-muted-foreground border-border";
};

export const getPriorityConfig = (priority?: number) => {
  if (priority === undefined || priority === null) return null;
  const badges: Record<number, { color: string; icon: string; label: string }> = {
    0: { color: "text-muted-foreground", icon: "↓", label: "Baja" },
    1: { color: "text-blue-600 dark:text-blue-400", icon: "→", label: "Media" },
    2: { color: "text-orange-600 dark:text-orange-400", icon: "↑", label: "Alta" },
    3: { color: "text-red-600 dark:text-red-400", icon: "⚠", label: "Urgente" },
  };
  return badges[priority] || badges[1];
};

/** Convierte status interno (ej: "en_proceso") a display legible ("En Proceso") */
export const getStatusDisplay = (status: string): string => {
  const map: Record<string, string> = {
    nueva: "Nueva",
    en_proceso: "En Proceso",
    estancada: "Estancada",
    finalizada: "Finalizada",
  };
  return map[status] || status;
};

// Tipos de archivo soportados para evaluación
export const SUPPORTED_EVAL_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

export const MAX_FILES = 3;

// Obtener icono según tipo de archivo
export const getFileIcon = (type: string) => {
  if (type.startsWith("image/")) return "🖼️";
  if (type === "application/pdf") return "📄";
  if (type.includes("word") || type === "application/msword") return "📝";
  return "📎";
};
