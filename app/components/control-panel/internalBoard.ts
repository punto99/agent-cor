import { BOARD_STAGES } from "../requests/boardStages";
import type { FullTask } from "./types";

export const PENDING_STAGE = { key: "pending_cor", label: "Sin ingresar a COR", subtitle: "Pendientes de publicación", accent: "border-t-slate-500", cardAccent: "border-l-slate-500" };
export function isTaskInCOR(task: Pick<FullTask, "corTaskId" | "corSyncStatus">) {
  return Boolean(task.corTaskId) || task.corSyncStatus === "synced";
}
export function internalBoardStage(task: FullTask) {
  return isTaskInCOR(task) ? task.status : PENDING_STAGE.key;
}
export function internalBoardStages(tasks: FullTask[]) {
  const known = [PENDING_STAGE, ...BOARD_STAGES];
  const unknown = [...new Set(tasks.map(internalBoardStage))].filter(key => !known.some(stage => stage.key === key));
  return [...known, ...unknown.map(key => ({ key, label: key || "Sin estado", subtitle: "Estado de la tarea", accent: "border-t-slate-400", cardAccent: "border-l-slate-400" }))];
}
