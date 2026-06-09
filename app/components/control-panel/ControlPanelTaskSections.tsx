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
  publishedProjectGroups: ControlPanelProjectGroup[];
  publishedTaskCount: number;
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
  publishedProjectGroups,
  publishedTaskCount,
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
          viewMode={viewMode}
          isOpen={isUnpublishedSectionOpen}
          onToggleOpen={onToggleUnpublishedSection}
          onSelectTask={onSelectTask}
        />
      )}

      {showPublishedSection && (
        <PublishedProjectsSection
          projectGroups={publishedProjectGroups}
          publishedTaskCount={publishedTaskCount}
          viewMode={viewMode}
          expandedProjectIds={expandedProjectIds}
          onToggleProjectExpanded={onToggleProjectExpanded}
          onSelectTask={onSelectTask}
        />
      )}
    </div>
  );
}
