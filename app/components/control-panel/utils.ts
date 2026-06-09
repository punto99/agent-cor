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
  const published = tasks.filter((task) => task.corSyncStatus === "synced")
    .length;

  return {
    total,
    published,
    publishedPercent: total > 0 ? (published / total) * 100 : 0,
    label: `${published}/${total}`,
  };
}
