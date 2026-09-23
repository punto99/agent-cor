import type { BoardStage } from "./types";

export const BOARD_STAGES: BoardStage[] = [
  { key: "nueva", label: "Nueva", subtitle: "Sin tomar", accent: "border-t-blue-500 dark:border-t-blue-400", cardAccent: "border-l-blue-500 dark:border-l-blue-400" },
  { key: "en_proceso", label: "En proceso", subtitle: "En producción", accent: "border-t-amber-500 dark:border-t-amber-400", cardAccent: "border-l-amber-500 dark:border-l-amber-400" },
  { key: "en_revision", label: "En revisión", subtitle: "Esperando feedback", accent: "border-t-purple-500 dark:border-t-purple-400", cardAccent: "border-l-purple-500 dark:border-l-purple-400" },
  { key: "en_diseno", label: "Ajustes", subtitle: "Cambios pedidos", accent: "border-t-orange-500 dark:border-t-orange-400", cardAccent: "border-l-orange-500 dark:border-l-orange-400" },
  { key: "finalizada", label: "Finalizada", subtitle: "Entregada", accent: "border-t-emerald-500 dark:border-t-emerald-400", cardAccent: "border-l-emerald-500 dark:border-l-emerald-400" },
  { key: "estancada", label: "Suspendida", subtitle: "En pausa", accent: "border-t-slate-500 dark:border-t-slate-400", cardAccent: "border-l-slate-500 dark:border-l-slate-400" },
];

