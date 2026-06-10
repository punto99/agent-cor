import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
} from "lucide-react";
import { TaskCard } from "./TaskCard";
import type {
  ControlPanelProjectGroup,
  ControlPanelView,
  FullTask,
} from "./types";
import {
  formatDeadline,
  formatTimestamp,
  getProjectProgress,
  getProjectUpdatedAt,
  getTaskCategoryLabel,
} from "./utils";
import {
  getStatusColor,
  getStatusDisplay,
} from "../task/types";

type PublishedProjectsSectionProps = {
  projectGroups: ControlPanelProjectGroup[];
  publishedTaskCount: number;
  viewMode: ControlPanelView;
  expandedProjectIds: Set<string>;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectTask: (task: FullTask) => void;
};

export function PublishedProjectsSection({
  projectGroups,
  publishedTaskCount,
  viewMode,
  expandedProjectIds,
  onToggleProjectExpanded,
  onSelectTask,
}: PublishedProjectsSectionProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-emerald-200/80 bg-emerald-50/30 dark:border-emerald-900/60 dark:bg-emerald-950/10">
      <div className="flex flex-col gap-3 border-b border-emerald-200/70 bg-emerald-50/60 px-4 py-4 dark:border-emerald-900/50 dark:bg-emerald-950/20 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">
              Proyectos en COR
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {projectGroups.length} proyecto
              {projectGroups.length !== 1 ? "s" : ""} · {publishedTaskCount}{" "}
              tarea
              {publishedTaskCount !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      {viewMode === "cards" ? (
        <div className="space-y-4 p-4">
          {projectGroups.map((projectGroup) => {
            const { project, tasks } = projectGroup;
            const progress = getProjectProgress(tasks);
            const updatedAt = getProjectUpdatedAt(projectGroup);

            return (
              <section
                key={project._id}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <div className="flex flex-col gap-3 border-b border-border bg-muted/35 px-4 py-3 dark:bg-muted/20 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderKanban className="h-4 w-4 flex-shrink-0 text-primary" />
                      <h4 className="truncate text-sm font-semibold text-foreground">
                        {project.name}
                      </h4>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tasks.length} tarea
                      {tasks.length !== 1 ? "s" : ""} · Última actualización{" "}
                      {formatTimestamp(updatedAt)}
                    </p>
                  </div>
                  <ProjectProgress progress={progress} />
                </div>

                <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {tasks.map((task) => (
                    <TaskCard
                      key={task._id}
                      task={task}
                      onClick={() => onSelectTask(task)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[800px]">
            <div className="grid grid-cols-[minmax(280px,1fr)_110px_190px_220px] items-center border-b border-emerald-200/70 bg-card/70 px-4 py-3 text-xs font-semibold text-muted-foreground dark:border-emerald-900/40 dark:bg-background/50">
              <div className="pl-8">Proyecto</div>
              <div>Tareas</div>
              <div>Progreso</div>
              <div>Última actualización</div>
            </div>

            <div className="divide-y divide-border">
              {projectGroups.map((projectGroup) => {
                const { project, tasks } = projectGroup;
                const projectId = String(project._id);
                const isExpanded = expandedProjectIds.has(projectId);
                const progress = getProjectProgress(tasks);
                const updatedAt = getProjectUpdatedAt(projectGroup);

                return (
                  <div key={project._id}>
                    <button
                      type="button"
                      onClick={() => onToggleProjectExpanded(projectId)}
                      className="grid w-full cursor-pointer grid-cols-[minmax(280px,1fr)_110px_190px_220px] items-center px-4 py-4 text-left transition-colors hover:bg-accent/60"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 flex-shrink-0 text-primary" />
                        ) : (
                          <ChevronRight className="h-4 w-4 flex-shrink-0 text-primary" />
                        )}
                        <span className="truncate text-sm font-semibold text-foreground">
                          {project.name}
                        </span>
                      </div>

                      <div className="text-sm font-medium text-muted-foreground">
                        {tasks.length}
                      </div>

                      <ProjectProgress progress={progress} />

                      <div className="text-sm text-muted-foreground">
                        {formatTimestamp(updatedAt)}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border bg-background">
                        {tasks.map((task) => {
                          const formattedDeadline = formatDeadline(
                            task.deadline,
                          );

                          return (
                            <button
                              key={task._id}
                              type="button"
                              onClick={() => onSelectTask(task)}
                              className="grid w-full cursor-pointer grid-cols-[minmax(280px,1fr)_110px_190px_220px] items-center px-4 py-3 text-left transition-colors hover:bg-accent"
                            >
                              <div className="flex min-w-0 items-center gap-3 pl-8">
                                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="truncate text-sm font-medium text-foreground">
                                      {task.title}
                                    </span>
                                    {task.source === "external" && (
                                      <span className="flex-shrink-0 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                        Cliente externo
                                      </span>
                                    )}
                                  </div>
                                  {task.brandName && (
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                      {getTaskCategoryLabel(task)}
                                    </p>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center">
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-xs ${getStatusColor(task.status)}`}
                                >
                                  {getStatusDisplay(task.status)}
                                </span>
                              </div>

                              <div className="flex items-center gap-2">
                                <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                                  Creada en COR
                                </span>
                                {(task.trelloSyncStatus === "synced" ||
                                  task.trelloCardId ||
                                  task.trelloCardUrl) && (
                                  <span className="rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
                                    En Trello
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                {formattedDeadline && (
                                  <>
                                    <CalendarDays className="h-3.5 w-3.5" />
                                    <span>{formattedDeadline}</span>
                                  </>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectProgress({
  progress,
}: {
  progress: ReturnType<typeof getProjectProgress>;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-emerald-500"
          style={{ width: `${progress.publishedPercent}%` }}
        />
      </div>
      <span className="text-xs font-medium text-muted-foreground">
        {progress.label}
      </span>
    </div>
  );
}
