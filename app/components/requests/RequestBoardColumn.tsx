import boardStyles from "../board/BoardLayout.module.css";
import type { BoardStage, ExternalRequest } from "./types";
import { RequestBoardCard } from "./RequestBoardCard";

export function RequestBoardColumn({ stage, requests }: { stage: BoardStage; requests: ExternalRequest[] }) {
  return (
    <section aria-label={stage.label} className={boardStyles.column}>
      <header className={boardStyles.header}>
        <div className={boardStyles.heading}>
          <span className={boardStyles.dot} data-stage={stage.key} aria-hidden="true" /><h2 className="text-sm font-semibold">{stage.label}</h2>
          <span className={boardStyles.count}>{requests.length}</span>
        </div>
        <p className={boardStyles.subtitle}>{stage.subtitle}</p>
      </header>
      <div className={boardStyles.cards}>
        {requests.length ? requests.map((request) => <RequestBoardCard key={request._id} request={request} />) :
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">Sin tareas en esta etapa</p>}
      </div>
    </section>
  );
}
