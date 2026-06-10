"use client";

import { useMemo, useState, useEffect } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { ControlPanelHeader } from "../../components/control-panel/ControlPanelHeader";
import { ControlPanelSidebar } from "../../components/control-panel/ControlPanelSidebar";
import { ControlPanelTaskSections } from "../../components/control-panel/ControlPanelTaskSections";
import { ControlPanelToast } from "../../components/control-panel/ControlPanelToast";
import { TaskDetailDialog } from "../../components/control-panel/TaskDetailDialog";
import type {
  ControlPanelClient,
  ControlPanelPublicationTab,
  ControlPanelToastState,
  ControlPanelView,
  FullTask,
} from "../../components/control-panel/types";
import { getTaskUpdatedAt } from "../../components/control-panel/utils";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";

const PANEL_PROJECT_PAGE_SIZE = 10;
const PANEL_TASK_PAGE_SIZE = 10;

export default function ControlPanelPage() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ControlPanelView>("cards");
  const [publicationTab, setPublicationTab] =
    useState<ControlPanelPublicationTab>("all");
  const [selectedTask, setSelectedTask] = useState<FullTask | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isUnpublishedSectionOpen, setIsUnpublishedSectionOpen] =
    useState(true);
  const [visibleUnpublishedLimit, setVisibleUnpublishedLimit] =
    useState(PANEL_TASK_PAGE_SIZE);
  const [visiblePublishedProjectLimit, setVisiblePublishedProjectLimit] =
    useState(PANEL_PROJECT_PAGE_SIZE);
  const [toast, setToast] = useState<ControlPanelToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const accessProfile = useQuery(api.data.userAccess.viewerAccessProfile);
  const preferences = useQuery(api.data.preferences.getUserPreferences) as
    | { controlPanelView?: ControlPanelView }
    | null
    | undefined;
  const setControlPanelView = useMutation(
    api.data.preferences.setControlPanelView,
  );

  useEffect(() => {
    if (accessProfile?.kind === "external") {
      router.replace("/workspace");
    }
  }, [accessProfile?.kind, router]);

  useEffect(() => {
    if (preferences === undefined) return;
    setViewMode(preferences?.controlPanelView ?? "cards");
  }, [preferences?.controlPanelView, preferences]);

  const handlePublishResult = (result: {
    success: boolean;
    message: string;
  }) => {
    setToast({
      type: result.success ? "success" : "error",
      message: result.message,
    });
  };

  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    {},
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);

  const panelClients = useQuery(api.data.controlPanel.listMyClientProjects, {
    status: statusFilter,
  }) as ControlPanelClient[] | undefined;

  const visibleClients = useMemo(() => {
    if (!panelClients) return [];
    const search = clientSearch.trim().toLowerCase();
    if (!search) return panelClients;
    return panelClients.filter(
      (entry) =>
        entry.client.name.toLowerCase().includes(search) ||
        entry.client.nomenclature?.toLowerCase().includes(search),
    );
  }, [panelClients, clientSearch]);

  const selectedClient = useMemo(() => {
    if (visibleClients.length === 0) return null;
    return (
      visibleClients.find(
        (entry) => String(entry.client._id) === selectedClientId,
      ) ?? visibleClients[0]
    );
  }, [visibleClients, selectedClientId]);

  const filteredProjects = useMemo(() => {
    if (!selectedClient) return [];
    const projects = selectedBrandId
      ? selectedClient.projects
          .map(({ project, tasks }) => ({
            project,
            tasks: tasks.filter(
              (task) => String(task.clientBrandId) === selectedBrandId,
            ),
          }))
          .filter(({ tasks }) => tasks.length > 0)
      : selectedClient.projects;

    return projects.map(({ project, tasks }) => ({
      project,
      tasks: [...tasks].sort((a, b) => b._creationTime - a._creationTime),
    }));
  }, [selectedClient, selectedBrandId]);

  const unpublishedTasks = useMemo(
    () =>
      filteredProjects
        .flatMap(({ tasks }) => tasks)
        .filter((task) => task.corSyncStatus !== "synced")
        .sort((a, b) => getTaskUpdatedAt(b) - getTaskUpdatedAt(a)),
    [filteredProjects],
  );

  const publishedProjectGroups = useMemo(
    () =>
      filteredProjects
        .map(({ project, tasks }) => ({
          project,
          tasks: tasks.filter((task) => task.corSyncStatus === "synced"),
        }))
        .filter(({ tasks }) => tasks.length > 0),
    [filteredProjects],
  );

  const publishedTaskCount = useMemo(
    () =>
      publishedProjectGroups.reduce(
        (total, projectGroup) => total + projectGroup.tasks.length,
        0,
      ),
    [publishedProjectGroups],
  );

  const visibleUnpublishedTasks = useMemo(
    () => unpublishedTasks.slice(0, visibleUnpublishedLimit),
    [unpublishedTasks, visibleUnpublishedLimit],
  );

  const visiblePublishedProjectGroups = useMemo(
    () => publishedProjectGroups.slice(0, visiblePublishedProjectLimit),
    [publishedProjectGroups, visiblePublishedProjectLimit],
  );

  const filteredTaskCount = useMemo(
    () =>
      filteredProjects.reduce(
        (total, projectGroup) => total + projectGroup.tasks.length,
        0,
      ),
    [filteredProjects],
  );

  const showUnpublishedSection =
    publicationTab !== "cor" && unpublishedTasks.length > 0;
  const showPublishedSection =
    publicationTab !== "unpublished" && publishedProjectGroups.length > 0;
  const hasVisibleTasksForTab = showUnpublishedSection || showPublishedSection;

  useEffect(() => {
    setVisibleUnpublishedLimit(PANEL_TASK_PAGE_SIZE);
    setVisiblePublishedProjectLimit(PANEL_PROJECT_PAGE_SIZE);
  }, [selectedClientId, selectedBrandId, statusFilter, publicationTab]);

  useEffect(() => {
    setExpandedProjectIds((current) => {
      const next = new Set<string>();
      for (const { project } of publishedProjectGroups) {
        const projectId = String(project._id);
        if (current.has(projectId) || next.size === 0) {
          next.add(projectId);
        }
      }
      return next;
    });
  }, [publishedProjectGroups]);

  useEffect(() => {
    if (!panelClients || panelClients.length === 0) {
      setSelectedClientId(null);
      return;
    }

    const hasSelected = panelClients.some(
      (entry) => String(entry.client._id) === selectedClientId,
    );
    if (!hasSelected) setSelectedClientId(String(panelClients[0].client._id));
  }, [panelClients, selectedClientId]);

  useEffect(() => {
    setSelectedBrandId(null);
  }, [selectedClientId]);

  useEffect(() => {
    if (!selectedClient || !selectedBrandId) return;
    const brandStillVisible = selectedClient.brands.some(
      (brand) => String(brand._id) === selectedBrandId,
    );
    if (!brandStillVisible) setSelectedBrandId(null);
  }, [selectedClient, selectedBrandId]);

  const handleNewThread = async () => {
    await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    window.location.href = "/workspace";
  };

  const handleSelectThread = (_threadId: string) => {
    window.location.href = "/workspace";
  };

  const handleViewModeChange = async (nextViewMode: ControlPanelView) => {
    if (nextViewMode === viewMode) return;
    setViewMode(nextViewMode);
    try {
      await setControlPanelView({ view: nextViewMode });
    } catch (error) {
      console.error("Error saving control panel view:", error);
    }
  };

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  if (threadsStatus === "LoadingFirstPage" || accessProfile === undefined) {
    return <LoadingScreen />;
  }

  if (accessProfile.kind === "external") {
    return <LoadingScreen />;
  }

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={handleSelectThread}
    >
      <div className="h-full flex flex-col bg-background">
        <div className="flex-1 min-h-0 grid grid-cols-[280px_1fr] bg-background">
          <ControlPanelSidebar
            panelClients={panelClients}
            visibleClients={visibleClients}
            selectedClient={selectedClient}
            clientSearch={clientSearch}
            onClientSearchChange={setClientSearch}
            onSelectClient={setSelectedClientId}
          />

          <section className="min-h-0 overflow-y-auto">
            {!panelClients ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-pulse text-muted-foreground">
                  Cargando panel...
                </div>
              </div>
            ) : !selectedClient ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <h3 className="text-lg font-medium text-foreground mb-2">
                  No hay tareas aún
                </h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Las tareas aparecerán aquí cuando exista trabajo para tus
                  clientes autorizados.
                </p>
              </div>
            ) : (
              <div className="p-6 max-w-7xl">
                <ControlPanelHeader
                  selectedClient={selectedClient}
                  selectedBrandId={selectedBrandId}
                  statusFilter={statusFilter}
                  viewMode={viewMode}
                  publicationTab={publicationTab}
                  filteredTaskCount={filteredTaskCount}
                  publishedTaskCount={publishedTaskCount}
                  unpublishedTaskCount={unpublishedTasks.length}
                  onSelectedBrandChange={setSelectedBrandId}
                  onStatusFilterChange={setStatusFilter}
                  onViewModeChange={handleViewModeChange}
                  onPublicationTabChange={setPublicationTab}
                />

                <ControlPanelTaskSections
                  filteredProjectsLength={filteredProjects.length}
                  hasVisibleTasksForTab={hasVisibleTasksForTab}
                  showUnpublishedSection={showUnpublishedSection}
                  showPublishedSection={showPublishedSection}
                  viewMode={viewMode}
                  unpublishedTasks={visibleUnpublishedTasks}
                  unpublishedTotalCount={unpublishedTasks.length}
                  hasMoreUnpublishedTasks={
                    visibleUnpublishedTasks.length < unpublishedTasks.length
                  }
                  onLoadMoreUnpublishedTasks={() =>
                    setVisibleUnpublishedLimit(
                      (limit) => limit + PANEL_TASK_PAGE_SIZE,
                    )
                  }
                  publishedProjectGroups={visiblePublishedProjectGroups}
                  publishedProjectTotalCount={publishedProjectGroups.length}
                  publishedTaskCount={publishedTaskCount}
                  hasMorePublishedProjects={
                    visiblePublishedProjectGroups.length <
                    publishedProjectGroups.length
                  }
                  onLoadMorePublishedProjects={() =>
                    setVisiblePublishedProjectLimit(
                      (limit) => limit + PANEL_PROJECT_PAGE_SIZE,
                    )
                  }
                  isUnpublishedSectionOpen={isUnpublishedSectionOpen}
                  expandedProjectIds={expandedProjectIds}
                  onToggleUnpublishedSection={() =>
                    setIsUnpublishedSectionOpen((open) => !open)
                  }
                  onToggleProjectExpanded={toggleProjectExpanded}
                  onSelectTask={setSelectedTask}
                />
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onPublishResult={handlePublishResult}
        />
      )}

      {toast && (
        <ControlPanelToast toast={toast} onClose={() => setToast(null)} />
      )}
    </WorkspaceLayout>
  );
}
