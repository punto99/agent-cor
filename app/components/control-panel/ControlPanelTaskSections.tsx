import { PublishedProjectsSection } from "./PublishedProjectsSection";
import { UnpublishedTasksSection } from "./UnpublishedTasksSection";
import type {
  ControlPanelProjectGroup,
  ControlPanelView,
  FullTask,
} from "./types";

type ControlPanelTaskSectionsProps = {
  filteredProjectsLength: number;
  hasVisibleTasksForTab: boolean;
  showUnpublishedSection: boolean;
  showPublishedSection: boolean;
  viewMode: ControlPanelView;
  unpublishedTasks: FullTask[];
  unpublishedTotalCount: number;
  hasMoreUnpublishedTasks: boolean;
  onLoadMoreUnpublishedTasks: () => void;
  publishedProjectGroups: ControlPanelProjectGroup[];
  publishedProjectTotalCount: number;
  publishedTaskCount: number;
  hasMorePublishedProjects: boolean;
  onLoadMorePublishedProjects: () => void;
  isUnpublishedSectionOpen: boolean;
  expandedProjectIds: Set<string>;
  onToggleUnpublishedSection: () => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onSelectTask: (task: FullTask) => void;
};

export function ControlPanelTaskSections({
  filteredProjectsLength,
  hasVisibleTasksForTab,
  showUnpublishedSection,
  showPublishedSection,
  viewMode,
  unpublishedTasks,
  unpublishedTotalCount,
  hasMoreUnpublishedTasks,
  onLoadMoreUnpublishedTasks,
  publishedProjectGroups,
  publishedProjectTotalCount,
  publishedTaskCount,
  hasMorePublishedProjects,
  onLoadMorePublishedProjects,
  isUnpublishedSectionOpen,
  expandedProjectIds,
  onToggleUnpublishedSection,
  onToggleProjectExpanded,
  onSelectTask,
}: ControlPanelTaskSectionsProps) {
  if (filteredProjectsLength === 0 || !hasVisibleTasksForTab) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <h3 className="text-sm font-medium text-foreground">
          No hay tareas para este filtro
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Cambia de marca o revisa el estado seleccionado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {showUnpublishedSection && (
        <UnpublishedTasksSection
          tasks={unpublishedTasks}
          totalTaskCount={unpublishedTotalCount}
          hasMoreTasks={hasMoreUnpublishedTasks}
          viewMode={viewMode}
          isOpen={isUnpublishedSectionOpen}
          onToggleOpen={onToggleUnpublishedSection}
          onLoadMore={onLoadMoreUnpublishedTasks}
          onSelectTask={onSelectTask}
        />
      )}

      {showPublishedSection && (
        <PublishedProjectsSection
          projectGroups={publishedProjectGroups}
          totalProjectCount={publishedProjectTotalCount}
          publishedTaskCount={publishedTaskCount}
          hasMoreProjects={hasMorePublishedProjects}
          viewMode={viewMode}
          expandedProjectIds={expandedProjectIds}
          onToggleProjectExpanded={onToggleProjectExpanded}
          onLoadMoreProjects={onLoadMorePublishedProjects}
          onSelectTask={onSelectTask}
        />
      )}
    </div>
  );
}
