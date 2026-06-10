import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { TaskCard } from "./TaskCard";
import type { ControlPanelView, FullTask } from "./types";
import {
  formatTimestamp,
  getTaskCategoryLabel,
  getTaskUpdatedAt,
} from "./utils";

type UnpublishedTasksSectionProps = {
  tasks: FullTask[];
  totalTaskCount: number;
  hasMoreTasks: boolean;
  viewMode: ControlPanelView;
  isOpen: boolean;
  onToggleOpen: () => void;
  onLoadMore: () => void;
  onSelectTask: (task: FullTask) => void;
};

export function UnpublishedTasksSection({
  tasks,
  totalTaskCount,
  hasMoreTasks,
  viewMode,
  isOpen,
  onToggleOpen,
  onLoadMore,
  onSelectTask,
}: UnpublishedTasksSectionProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-amber-200/80 bg-amber-50/35 dark:border-amber-900/60 dark:bg-amber-950/10">
      <button
        type="button"
        onClick={onToggleOpen}
        className={`flex w-full cursor-pointer flex-col gap-3 bg-amber-50/60 px-4 py-4 text-left outline-none transition-colors hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30 sm:flex-row sm:items-center sm:justify-between ${
          isOpen ? "border-b border-amber-200/70 dark:border-amber-900/50" : ""
        }`}
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            <AlertCircle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground transition-colors">
              Tareas aún no publicadas en COR
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {totalTaskCount} tarea
              {totalTaskCount !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 items-center rounded-md border border-amber-200 bg-card px-3 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-background dark:text-amber-300">
            Pendientes de publicar
          </span>
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          ) : (
            <ChevronRight className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          )}
        </div>
      </button>

      {isOpen && (
        <>
          {viewMode === "cards" ? (
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {tasks.map((task) => (
                <TaskCard
                  key={task._id}
                  task={task}
                  onClick={() => onSelectTask(task)}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[900px]">
                <div className="grid grid-cols-[minmax(340px,1fr)_240px_220px_220px_44px] items-center gap-x-8 border-b border-amber-200/70 bg-card/70 px-4 py-3 text-xs font-semibold text-muted-foreground dark:border-amber-900/40 dark:bg-background/50">
                  <div className="pl-8">Tarea</div>
                  <div>Categoría</div>
                  <div>Fecha de creación</div>
                  <div>Última actualización</div>
                  <div />
                </div>

                <div className="divide-y divide-amber-200/70 dark:divide-amber-900/40">
                  {tasks.map((task) => (
                    <button
                      key={task._id}
                      type="button"
                      onClick={() => onSelectTask(task)}
                      className="grid w-full cursor-pointer grid-cols-[minmax(340px,1fr)_240px_220px_220px_44px] items-center gap-x-8 px-4 py-3 text-left transition-colors hover:bg-amber-100/40 dark:hover:bg-amber-950/20"
                    >
                      <div className="flex min-w-0 items-center gap-3 pl-8">
                        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-400" />
                        <div className="min-w-0">
                          <div className="min-w-0 space-y-1">
                            <span className="block truncate text-sm font-semibold text-foreground">
                              {task.title}
                            </span>
                            {task.source === "external" && (
                              <span className="inline-flex w-fit rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                Cliente externo
                              </span>
                            )}
                            {(task.trelloSyncStatus === "synced" ||
                              task.trelloCardId ||
                              task.trelloCardUrl) && (
                              <span className="inline-flex w-fit rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
                                En Trello
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="truncate text-sm text-muted-foreground">
                        {getTaskCategoryLabel(task)}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {formatTimestamp(task._creationTime)}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {formatTimestamp(getTaskUpdatedAt(task))}
                      </div>

                      <ChevronRight className="h-4 w-4 text-primary" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {hasMoreTasks && (
            <div className="flex justify-center border-t border-amber-200/70 px-4 py-3 dark:border-amber-900/40">
              <button
                type="button"
                onClick={onLoadMore}
                className="cursor-pointer rounded-lg border border-amber-200 bg-card px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-800 dark:bg-background dark:text-amber-300 dark:hover:bg-amber-950/30"
              >
                Cargar más tareas
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
