import type { FullTask } from "./types";
import { BoardCardContent } from "../board/BoardCardContent";
import styles from "../board/BoardCard.module.css";

export function InternalBoardCard({ task, onSelect }: { task: FullTask; onSelect: (task: FullTask) => void }) {
  return <button type="button" aria-haspopup="dialog" aria-label={task.title} onClick={() => onSelect(task)} className={styles.card}>
    <BoardCardContent title={task.title} description={task.description} deadline={task.deadline}
      status={task.status} label={task.boardLabel} deliverablesCount={task.deliverablesCount}
      createdByName={task.createdByName} syncStatus={task.corSyncStatus} />
  </button>;
}
