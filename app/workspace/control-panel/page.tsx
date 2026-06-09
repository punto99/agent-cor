"use client";

import { useMemo, useState, useEffect } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskCard } from "../../components/control-panel/TaskCard";
import { TaskDetailDialog } from "../../components/control-panel/TaskDetailDialog";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";
import { LoadingScreen } from "../../components/LoadingScreen";
import { useMutation } from "convex/react";
import {
  Filter,
  CheckCircle2,
  AlertCircle,
  X,
  Search,
  Building2,
  FolderKanban,
  CalendarDays,
  LayoutGrid,
  List as ListIcon,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  getStatusColor,
  getStatusDisplay,
} from "../../components/task/types";

// Tipo local que extiende Task con los campos de sincronización
// (el schema los tiene pero el type de task/types.ts no los incluye)
interface FullTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;
  deadline?: string;
  deliverablesCount?: number;
  priority?: number; // 0=Low, 1=Medium, 2=High, 3=Urgent
  strategicPriority?: "I_U" | "I_NU" | "NI_U" | "NI_NU";
  status: string;
  threadId: string;
  createdBy?: string;
  corTaskId?: string;
  corProjectId?: number;
  corSyncStatus?: string;
  corSyncError?: string;
  corSyncedAt?: number;
  corTaskMissingInCOR?: boolean;
  corProjectMissingInCOR?: boolean;
  corClientId?: number;
  corClientName?: string;
  corDescriptionHash?: string;
  lastLocalEditAt?: number;
  projectId?: Id<"projects">;
  source?: "internal" | "external";
  brandName?: string;
  clientBrandId?: Id<"clientBrands">;
  brandId?: number;
  subBrandId?: Id<"subBrands">;
  productId?: number;
  subBrandName?: string;
  trelloCardId?: string;
  trelloCardUrl?: string;
  trelloSyncStatus?: string;
  trelloSyncError?: string;
  trelloSyncedAt?: number;
}

interface ControlPanelClient {
  client: {
    _id: Id<"corClients">;
    name: string;
    nomenclature?: string;
    corClientId: number;
  };
  brands: Array<{
    _id: Id<"clientBrands">;
    name: string;
    corBrandId: number;
    taskCount?: number;
  }>;
  taskCount: number;
  projectCount: number;
  projects: Array<{
    project: {
      _id: Id<"projects"> | string;
      _creationTime?: number;
      name: string;
      status?: string;
      endDate?: string;
      source?: "internal" | "external";
    };
    tasks: FullTask[];
  }>;
}

type ControlPanelView = "cards" | "list";
type ControlPanelPublicationTab = "all" | "cor" | "unpublished";

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
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Auto-dismiss toast after 5 seconds
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

  // Obtener threads para el sidebar del WorkspaceLayout
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
    const newThreadId = await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    // Redirigir al workspace con el nuevo thread
    window.location.href = "/workspace";
  };

  const handleSelectThread = (threadId: string) => {
    // Al seleccionar un thread, ir al chat
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

  // Loading state
  if (threadsStatus === "LoadingFirstPage" || accessProfile === undefined) {
    return <LoadingScreen />;
  }

  if (accessProfile.kind === "external") {
    return <LoadingScreen />;
  }

  const statusOptions = [
    { value: undefined, label: "Todas" },
    { value: "nueva", label: "Nueva" },
    { value: "en_proceso", label: "En Proceso" },
    { value: "en_revision", label: "En Revisión" },
    { value: "en_diseno", label: "Ajustes" },
    { value: "estancada", label: "Suspendida" },
    { value: "finalizada", label: "Finalizada" },
  ];

  const formatDeadline = (deadline?: string) => {
    if (!deadline) return null;
    const normalized = deadline.slice(0, 10);
    const [year, month, day] = normalized.split("-");
    if (!year || !month || !day) return deadline;
    return `${day}/${month}/${year}`;
  };

  function getTaskUpdatedAt(task: FullTask) {
    return Math.max(
      task.lastLocalEditAt ?? 0,
      task.corSyncedAt ?? 0,
      task.trelloSyncedAt ?? 0,
      task._creationTime,
    );
  }

  function getProjectUpdatedAt(project: ControlPanelClient["projects"][number]) {
    return Math.max(
      project.project._creationTime ?? 0,
      ...project.tasks.map((task) => getTaskUpdatedAt(task)),
    );
  }

  const formatTimestamp = (value?: number) => {
    if (!value) return "Sin fecha";
    return new Intl.DateTimeFormat("es-EC", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  };

  const getTaskCategoryLabel = (task: FullTask) => {
    const category = task.brandName ?? "Sin categoría";
    return task.subBrandName ? `${category} · ${task.subBrandName}` : category;
  };

  const getProjectProgress = (tasks: FullTask[]) => {
    const total = tasks.length;
    const published = tasks.filter(
      (task) => task.corSyncStatus === "synced",
    ).length;

    return {
      total,
      published,
      publishedPercent: total > 0 ? (published / total) * 100 : 0,
      label: `${published}/${total}`,
    };
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
          <aside className="border-r border-border bg-card min-h-0 flex flex-col">
            <div className="p-4 border-b border-border">
              <div className="flex items-center gap-2 mb-3">
                <Building2 className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">
                  Clientes
                </h2>
              </div>
              <div className="relative">
                <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={clientSearch}
                  onChange={(event) => setClientSearch(event.target.value)}
                  placeholder="Buscar cliente"
                  className="w-full h-9 rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {!panelClients ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  Cargando clientes...
                </div>
              ) : visibleClients.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No hay clientes para mostrar.
                </div>
              ) : (
                <div className="space-y-1">
                  {visibleClients.map((entry) => {
                    const isSelected =
                      String(entry.client._id) ===
                      String(selectedClient?.client._id);

                    return (
                      <button
                        key={entry.client._id}
                        onClick={() =>
                          setSelectedClientId(String(entry.client._id))
                        }
                        className={`w-full cursor-pointer text-left rounded-md px-3 py-2 transition-colors ${
                          isSelected
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-accent"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium truncate">
                            {entry.client.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {entry.taskCount}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {entry.projectCount} proyecto
                          {entry.projectCount !== 1 ? "s" : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

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
                <div className="mb-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-semibold text-foreground">
                        {selectedClient.client.name}
                      </h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        {selectedClient.projectCount} proyecto
                        {selectedClient.projectCount !== 1 ? "s" : ""} ·{" "}
                        {selectedClient.taskCount} tarea
                        {selectedClient.taskCount !== 1 ? "s" : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-3">
                      <div className="inline-flex h-9 rounded-lg border border-border bg-card p-1">
                        <button
                          type="button"
                          onClick={() => handleViewModeChange("cards")}
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                            viewMode === "cards"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                          title="Ver como cards"
                        >
                          <LayoutGrid className="h-3.5 w-3.5" />
                          Cards
                        </button>
                        <button
                          type="button"
                          onClick={() => handleViewModeChange("list")}
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                            viewMode === "list"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                          title="Ver como lista"
                        >
                          <ListIcon className="h-3.5 w-3.5" />
                          Lista
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Filter className="h-4 w-4 text-muted-foreground" />
                        {selectedClient.brands.length > 0 && (
                          <select
                            value={selectedBrandId || ""}
                            onChange={(event) =>
                              setSelectedBrandId(event.target.value || null)
                            }
                            className="h-9 max-w-[220px] cursor-pointer rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                          >
                            <option value="">Todas las categorías</option>
                            {selectedClient.brands.map((brand) => (
                              <option key={brand._id} value={String(brand._id)}>
                                {brand.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <select
                          value={statusFilter || ""}
                          onChange={(event) =>
                            setStatusFilter(event.target.value || undefined)
                          }
                          className="h-9 cursor-pointer rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                        >
                          {statusOptions.map((opt) => (
                            <option key={opt.label} value={opt.value || ""}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 border-b border-border">
                    <div className="flex flex-wrap items-center gap-6">
                      <button
                        type="button"
                        onClick={() => setPublicationTab("all")}
                        className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
                          publicationTab === "all"
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Todas ({filteredTaskCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPublicationTab("cor")}
                        className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
                          publicationTab === "cor"
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        En COR ({publishedTaskCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPublicationTab("unpublished")}
                        className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
                          publicationTab === "unpublished"
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Sin publicar ({unpublishedTasks.length})
                      </button>
                    </div>
                  </div>
                </div>

                {filteredProjects.length === 0 || !hasVisibleTasksForTab ? (
                  <div className="border border-border rounded-lg bg-card p-8 text-center">
                    <h3 className="text-sm font-medium text-foreground">
                      No hay tareas para este filtro
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Cambia de marca o revisa el estado seleccionado.
                    </p>
                  </div>
                ) : viewMode === "cards" ? (
                  <div className="space-y-5">
                    {showUnpublishedSection && (
                      <section className="overflow-hidden rounded-lg border border-amber-200/80 bg-amber-50/35 dark:border-amber-900/60 dark:bg-amber-950/10">
                        <button
                          type="button"
                          onClick={() =>
                            setIsUnpublishedSectionOpen((open) => !open)
                          }
                          className={`flex w-full cursor-pointer flex-col gap-3 bg-amber-50/60 px-4 py-4 text-left outline-none transition-colors hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30 sm:flex-row sm:items-center sm:justify-between ${
                            isUnpublishedSectionOpen
                              ? "border-b border-amber-200/70 dark:border-amber-900/50"
                              : ""
                          }`}
                          aria-expanded={isUnpublishedSectionOpen}
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
                                {unpublishedTasks.length} tarea
                                {unpublishedTasks.length !== 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex h-8 items-center rounded-md border border-amber-200 bg-card px-3 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-background dark:text-amber-300">
                              Pendientes de publicar
                            </span>
                            {isUnpublishedSectionOpen ? (
                              <ChevronDown className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                            )}
                          </div>
                        </button>

                        {isUnpublishedSectionOpen && (
                          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {unpublishedTasks.map((task) => (
                              <TaskCard
                                key={task._id}
                                task={task}
                                onClick={() => setSelectedTask(task)}
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    )}

                    {showPublishedSection && (
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
                                {publishedProjectGroups.length} proyecto
                                {publishedProjectGroups.length !== 1
                                  ? "s"
                                  : ""}{" "}
                                · {publishedTaskCount} tarea
                                {publishedTaskCount !== 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4 p-4">
                          {publishedProjectGroups.map((projectGroup) => {
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
                                      {tasks.length !== 1 ? "s" : ""} · Última
                                      actualización {formatTimestamp(updatedAt)}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                      <div
                                        className="h-full rounded-full bg-emerald-500"
                                        style={{
                                          width: `${progress.publishedPercent}%`,
                                        }}
                                      />
                                    </div>
                                    <span className="text-xs font-medium text-muted-foreground">
                                      {progress.label}
                                    </span>
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                  {tasks.map((task) => (
                                    <TaskCard
                                      key={task._id}
                                      task={task}
                                      onClick={() => setSelectedTask(task)}
                                    />
                                  ))}
                                </div>
                              </section>
                            );
                          })}
                        </div>
                      </section>
                    )}
                  </div>
                ) : (
                  <div className="space-y-5">
                    {showUnpublishedSection && (
                      <section className="overflow-hidden rounded-lg border border-amber-200/80 bg-amber-50/35 dark:border-amber-900/60 dark:bg-amber-950/10">
                        <button
                          type="button"
                          onClick={() =>
                            setIsUnpublishedSectionOpen((open) => !open)
                          }
                          className={`flex w-full cursor-pointer flex-col gap-3 bg-amber-50/60 px-4 py-4 text-left outline-none transition-colors hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30 sm:flex-row sm:items-center sm:justify-between ${
                            isUnpublishedSectionOpen
                              ? "border-b border-amber-200/70 dark:border-amber-900/50"
                              : ""
                          }`}
                          aria-expanded={isUnpublishedSectionOpen}
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
                                {unpublishedTasks.length} tarea
                                {unpublishedTasks.length !== 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex h-8 items-center rounded-md border border-amber-200 bg-card px-3 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-background dark:text-amber-300">
                              Pendientes de publicar
                            </span>
                            {isUnpublishedSectionOpen ? (
                              <ChevronDown className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                            )}
                          </div>
                        </button>

                        {isUnpublishedSectionOpen && (
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
                                {unpublishedTasks.map((task) => (
                                  <button
                                    key={task._id}
                                    type="button"
                                    onClick={() => setSelectedTask(task)}
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
                      </section>
                    )}

                    {showPublishedSection && (
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
                                {publishedProjectGroups.length} proyecto
                                {publishedProjectGroups.length !== 1
                                  ? "s"
                                  : ""}{" "}
                                · {publishedTaskCount} tarea
                                {publishedTaskCount !== 1 ? "s" : ""}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <div className="min-w-[800px]">
                            <div className="grid grid-cols-[minmax(280px,1fr)_110px_190px_220px] items-center border-b border-emerald-200/70 bg-card/70 px-4 py-3 text-xs font-semibold text-muted-foreground dark:border-emerald-900/40 dark:bg-background/50">
                              <div className="pl-8">Proyecto</div>
                              <div>Tareas</div>
                              <div>Progreso</div>
                              <div>Última actualización</div>
                            </div>

                            <div className="divide-y divide-border">
                              {publishedProjectGroups.map((projectGroup) => {
                                const { project, tasks } = projectGroup;
                                const projectId = String(project._id);
                                const isExpanded =
                                  expandedProjectIds.has(projectId);
                                const progress = getProjectProgress(tasks);
                                const updatedAt =
                                  getProjectUpdatedAt(projectGroup);

                                return (
                                  <div key={project._id}>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleProjectExpanded(projectId)
                                      }
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

                                      <div className="flex items-center gap-3">
                                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                          <div
                                            className="h-full rounded-full bg-emerald-500"
                                            style={{
                                              width: `${progress.publishedPercent}%`,
                                            }}
                                          />
                                        </div>
                                        <span className="text-xs font-medium text-muted-foreground">
                                          {progress.label}
                                        </span>
                                      </div>

                                      <div className="text-sm text-muted-foreground">
                                        {formatTimestamp(updatedAt)}
                                      </div>
                                    </button>

                                    {isExpanded && (
                                      <div className="border-t border-border bg-background">
                                        {tasks.map((task) => {
                                          const formattedDeadline =
                                            formatDeadline(task.deadline);

                                          return (
                                            <button
                                              key={task._id}
                                              type="button"
                                              onClick={() =>
                                                setSelectedTask(task)
                                              }
                                              className="grid w-full cursor-pointer grid-cols-[minmax(280px,1fr)_110px_190px_220px] items-center px-4 py-3 text-left transition-colors hover:bg-accent"
                                            >
                                              <div className="flex min-w-0 items-center gap-3 pl-8">
                                                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                                                <div className="min-w-0">
                                                  <div className="flex min-w-0 items-center gap-2">
                                                    <span className="truncate text-sm font-medium text-foreground">
                                                      {task.title}
                                                    </span>
                                                    {task.source ===
                                                      "external" && (
                                                      <span className="flex-shrink-0 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                                        Cliente externo
                                                      </span>
                                                    )}
                                                  </div>
                                                  {task.brandName && (
                                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                                      {getTaskCategoryLabel(
                                                        task,
                                                      )}
                                                    </p>
                                                  )}
                                                </div>
                                              </div>

                                              <div className="flex items-center">
                                                <span
                                                  className={`rounded-full border px-2 py-0.5 text-xs ${getStatusColor(task.status)}`}
                                                >
                                                  {getStatusDisplay(
                                                    task.status,
                                                  )}
                                                </span>
                                              </div>

                                              <div className="flex items-center gap-2">
                                                <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                                                  Creada en COR
                                                </span>
                                              </div>

                                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                                {formattedDeadline && (
                                                  <>
                                                    <CalendarDays className="h-3.5 w-3.5" />
                                                    <span>
                                                      {formattedDeadline}
                                                    </span>
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
                      </section>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Task Detail Dialog */}
      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onPublishResult={handlePublishResult}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div
            className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border ${
              toast.type === "success"
                ? "bg-emerald-50 dark:bg-emerald-950/80 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
                : "bg-red-50 dark:bg-red-950/80 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
            )}
            <p className="text-sm font-medium">{toast.message}</p>
            <button
              onClick={() => setToast(null)}
              className="ml-2 cursor-pointer rounded p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
