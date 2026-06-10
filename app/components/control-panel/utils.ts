import type { ControlPanelProjectGroup, FullTask } from "./types";

export const STATUS_OPTIONS: Array<{ value: string | undefined; label: string }> =
  [
    { value: undefined, label: "Todas" },
    { value: "nueva", label: "Nueva" },
    { value: "en_proceso", label: "En Proceso" },
    { value: "en_revision", label: "En Revisión" },
    { value: "en_diseno", label: "Ajustes" },
    { value: "estancada", label: "Suspendida" },
    { value: "finalizada", label: "Finalizada" },
  ];

export function formatDeadline(deadline?: string) {
  if (!deadline) return null;
  const normalized = deadline.slice(0, 10);
  const [year, month, day] = normalized.split("-");
  if (!year || !month || !day) return deadline;
  return `${day}/${month}/${year}`;
}

export function getTaskUpdatedAt(task: FullTask) {
  return Math.max(
    task.lastLocalEditAt ?? 0,
    task.corSyncedAt ?? 0,
    task.trelloSyncedAt ?? 0,
    task._creationTime,
  );
}

export function getProjectUpdatedAt(project: ControlPanelProjectGroup) {
  return Math.max(
    project.project._creationTime ?? 0,
    ...project.tasks.map((task) => getTaskUpdatedAt(task)),
  );
}

export function formatTimestamp(value?: number) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-EC", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function getTaskCategoryLabel(task: FullTask) {
  const category = task.brandName ?? "Sin categoría";
  return task.subBrandName ? `${category} · ${task.subBrandName}` : category;
}

export function getProjectProgress(tasks: FullTask[]) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === "finalizada")
    .length;

  return {
    total,
    completed,
    completedPercent: total > 0 ? (completed / total) * 100 : 0,
    label: `${completed}/${total}`,
  };
}

export function getProjectStatusDisplay(status?: string) {
  const labels: Record<string, string> = {
    active: "Nuevo",
    in_process: "En Proceso",
    suspended: "Suspendido",
    finished: "Finalizado",
  };
  return labels[status || ""] || status || "Sin estado";
}

export function getProjectStatusColor(status?: string) {
  const colors: Record<string, string> = {
    active:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    in_process:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    suspended:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300",
    finished:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  };
  return colors[status || ""] || "border-border bg-muted text-muted-foreground";
}
