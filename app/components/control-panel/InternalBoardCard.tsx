import type { FullTask } from "./types";
import { BoardCardContent } from "../board/BoardCardContent";
import { creatorInitials } from "../board/cardPresentation";
import styles from "../board/BoardCard.module.css";

export function InternalBoardCard({ task, onSelect }: { task: FullTask; onSelect: (task: FullTask) => void }) {
  const creatorName = task.createdByName?.trim() || task.createdByEmail?.trim() || "Usuario";
  const isExternal = task.source === "external";
  return <button type="button" aria-haspopup="dialog" aria-label={task.title} onClick={() => onSelect(task)} className={styles.card}>
    <BoardCardContent title={task.title} description={task.description} deadline={task.deadline}
      status={task.status} label={task.boardLabel} deliverablesCount={task.deliverablesCount}
      syncStatus={task.corSyncStatus} />
    <span className="mt-3 flex min-w-0 items-center gap-2 text-xs">
      <span className={`${styles.avatar} shrink-0`} aria-hidden="true">{creatorInitials(creatorName)}</span>
      <span className="min-w-0 flex-1 truncate font-medium" title={`Creada por ${creatorName}`}>{creatorName}</span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${isExternal
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"}`}>
        {isExternal ? "Externo" : "Interno"}
      </span>
    </span>
  </button>;
}
