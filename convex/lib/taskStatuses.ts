export const TASK_STATUS_OPTIONS = [
  { value: "nueva", name: "Nueva" },
  { value: "en_proceso", name: "En proceso" },
  { value: "en_revision", name: "En Revisión" },
  { value: "en_diseno", name: "Ajustes" },
  { value: "finalizada", name: "Finalizada" },
  { value: "estancada", name: "Suspendida" },
] as const;

export type TaskStatusValue = (typeof TASK_STATUS_OPTIONS)[number]["value"];

export function getTaskStatusName(status: string) {
  return TASK_STATUS_OPTIONS.find((option) => option.value === status)?.name ?? status;
}
