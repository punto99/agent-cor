import boardStyles from "../board/BoardLayout.module.css";
import { BOARD_STAGES } from "./boardStages";
import { RequestBoardColumn } from "./RequestBoardColumn";
import type { ExternalRequest } from "./types";

export function RequestsBoard({ requests }: { requests: ExternalRequest[] }) {
  const unknown = Array.from(new Set(requests.map((r) => r.status))).filter((status) => !BOARD_STAGES.some((stage) => stage.key === status));
  const stages = [...BOARD_STAGES, ...unknown.map((status) => ({ key: status, label: status || "Sin estado", subtitle: "Estado de la tarea", accent: "border-t-slate-500 dark:border-t-slate-400", cardAccent: "border-l-slate-500 dark:border-l-slate-400" }))];
  return (
    <div tabIndex={0} role="region" aria-label="Board de tareas por estado" className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 pb-4 focus-visible:outline-2 focus-visible:outline-ring sm:px-6">
      <div className={boardStyles.grid}>
        {stages.map((stage) => <RequestBoardColumn key={stage.key} stage={stage} requests={requests.filter((r) => r.status === stage.key)} />)}
      </div>
    </div>
  );
}
