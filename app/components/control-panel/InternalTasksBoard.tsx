import boardStyles from "../board/BoardLayout.module.css";
import { InternalBoardCard } from "./InternalBoardCard";
import { internalBoardStage, internalBoardStages, isTaskInCOR } from "./internalBoard";
import type { ControlPanelProjectGroup, ControlPanelPublicationTab, FullTask } from "./types";

export function InternalTasksBoard({ projects, publicationTab, onSelectTask }: { projects: ControlPanelProjectGroup[]; publicationTab: ControlPanelPublicationTab; onSelectTask: (task: FullTask) => void }) {
  const rows = projects.flatMap(({ tasks }) => tasks.map(task => ({ task })));
  const visible = rows.filter(({ task }) => publicationTab === "all" || (publicationTab === "cor" ? isTaskInCOR(task) : !isTaskInCOR(task)));
  return <div role="region" aria-label="Board de tareas internas" tabIndex={0} className="min-h-0 flex-1 overflow-x-auto pb-3 focus-visible:outline-2 focus-visible:outline-ring">
    <div className={boardStyles.grid}>
      {internalBoardStages(rows.map(row => row.task)).map(stage => {
        const cards = visible.filter(({ task }) => internalBoardStage(task) === stage.key);
        return <section key={stage.key} aria-label={stage.label} className={boardStyles.column}>
          <header className={boardStyles.header}>
            <div className={boardStyles.heading}><span className={boardStyles.dot} data-stage={stage.key} aria-hidden="true" /><h2 className="text-sm font-semibold">{stage.label}</h2><span className={boardStyles.count}>{cards.length}</span></div>
            <p className={boardStyles.subtitle}>{stage.subtitle}</p>
          </header>
          <div className={boardStyles.cards}>
            {cards.length ? cards.map(({ task }) => <InternalBoardCard key={task._id} task={task} onSelect={onSelectTask} />) : <p className="px-2 py-8 text-center text-xs text-muted-foreground">Sin tareas en esta etapa</p>}
          </div>
        </section>;
      })}
    </div>
  </div>;
}
