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
  ExternalLink,
  GripVertical,
  LayoutGrid,
  List as ListIcon,
} from "lucide-react";
import {
  getPriorityConfig,
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
  trelloCardId?: string;
  trelloCardUrl?: string;
  trelloSyncStatus?: string;
  trelloSyncError?: string;
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
      name: string;
      status?: string;
      endDate?: string;
      source?: "internal" | "external";
    };
    tasks: FullTask[];
  }>;
}

type ControlPanelView = "cards" | "list";

export default function ControlPanelPage() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ControlPanelView>("cards");
  const [selectedTask, setSelectedTask] = useState<FullTask | null>(null);
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

  const getStrategicPriorityConfig = (
    value?: FullTask["strategicPriority"],
  ) => {
    if (!value) return null;
    const map: Record<string, string> = {
      I_NU: "bg-amber-100 text-amber-800 border-amber-200",
      I_U: "bg-rose-100 text-rose-800 border-rose-200",
      NI_NU: "bg-emerald-100 text-emerald-800 border-emerald-200",
      NI_U: "bg-cyan-100 text-cyan-800 border-cyan-200",
    };
    return {
      label: value,
      className: map[value] ?? "bg-muted text-muted-foreground border-border",
    };
  };

  const getPriorityBadgeClass = (priority?: number) => {
    const map: Record<number, string> = {
      0: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
      1: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
      2: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
      3: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300",
    };
    return priority === undefined || priority === null
      ? "border-border bg-muted text-muted-foreground"
      : (map[priority] ?? map[1]);
  };

  const formatDeadline = (deadline?: string) => {
    if (!deadline) return null;
    const normalized = deadline.slice(0, 10);
    const [year, month, day] = normalized.split("-");
    if (!year || !month || !day) return deadline;
    return `${day}/${month}/${year}`;
  };

  const getBrandDotClass = (index: number) => {
    const colors = [
      "bg-indigo-500",
      "bg-blue-500",
      "bg-rose-500",
      "bg-emerald-500",
      "bg-amber-500",
      "bg-cyan-500",
    ];
    return colors[index % colors.length];
  };

  const getCorActionLabel = (task: FullTask) => {
    if (task.corSyncStatus === "synced") return "Publicado";
    if (task.corSyncStatus === "syncing" || task.corSyncStatus === "retrying") {
      return "Publicando...";
    }
    if (task.corSyncStatus === "error") return "Reintentar en COR";
    return "Publicar en COR";
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
                        className={`w-full text-left rounded-md px-3 py-2 transition-colors ${
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

                    <div className="flex items-center gap-3">
                      <div className="inline-flex h-9 rounded-lg border border-border bg-card p-1">
                        <button
                          type="button"
                          onClick={() => handleViewModeChange("cards")}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
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
                          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
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

                      <div className="flex items-center gap-2">
                        <Filter className="h-4 w-4 text-muted-foreground" />
                        <select
                          value={statusFilter || ""}
                          onChange={(event) =>
                            setStatusFilter(event.target.value || undefined)
                          }
                          className="h-9 rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
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

                  {selectedClient.brands.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedBrandId(null)}
                        className={`inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors ${
                          selectedBrandId === null
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        Todas las categorías
                      </button>
                      {selectedClient.brands.map((brand, index) => {
                        const isSelected =
                          selectedBrandId === String(brand._id);

                        return (
                          <button
                            key={brand._id}
                            type="button"
                            onClick={() =>
                              setSelectedBrandId(String(brand._id))
                            }
                            className={`inline-flex h-8 max-w-[220px] items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${
                              isSelected
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent"
                            }`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${getBrandDotClass(index)}`}
                            />
                            <span className="truncate">{brand.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {filteredProjects.length === 0 ? (
                  <div className="border border-border rounded-lg bg-card p-8 text-center">
                    <h3 className="text-sm font-medium text-foreground">
                      No hay tareas para este filtro
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Cambia de marca o revisa el estado seleccionado.
                    </p>
                  </div>
                ) : viewMode === "cards" ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filteredProjects.flatMap(({ tasks }) =>
                      tasks.map((task) => (
                        <TaskCard
                          key={task._id}
                          task={task}
                          onClick={() => setSelectedTask(task)}
                        />
                      )),
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredProjects.map(({ project, tasks }) => {
                      const projectBrands = Array.from(
                        new Set(
                          tasks
                            .map((task) => task.brandName)
                            .filter(Boolean) as string[],
                        ),
                      );

                      return (
                        <div
                          key={project._id}
                          className="border border-border rounded-lg bg-card overflow-hidden"
                        >
                          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 bg-muted/70 dark:bg-muted/40">
                            <div className="min-w-0 flex items-center gap-2">
                              <FolderKanban className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <h3 className="text-sm font-semibold text-foreground truncate">
                                    {project.name}
                                  </h3>
                                  {projectBrands.map((brandName) => (
                                    <span
                                      key={brandName}
                                      className="text-[11px] px-2 py-0.5 rounded-md border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 flex-shrink-0"
                                    >
                                      {brandName}
                                    </span>
                                  ))}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {tasks.length} tarea
                                  {tasks.length !== 1 ? "s" : ""}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="divide-y divide-border">
                            {tasks.map((task) => {
                              const priorityConfig = getPriorityConfig(
                                task.priority,
                              );
                              const strategicPriorityConfig =
                                getStrategicPriorityConfig(
                                  task.strategicPriority,
                                );
                              const formattedDeadline = formatDeadline(
                                task.deadline,
                              );

                              return (
                                <button
                                  key={task._id}
                                  type="button"
                                  onClick={() => setSelectedTask(task)}
                                  className="w-full px-4 py-3 text-left hover:bg-accent transition-colors"
                                >
                                  <div className="flex items-center gap-3">
                                    <GripVertical className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                                        <p className="text-sm font-medium text-foreground truncate">
                                          {task.title}
                                        </p>
                                        {task.source === "external" && (
                                          <span className="text-[11px] px-2 py-0.5 rounded-md border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 flex-shrink-0">
                                            Cliente externo
                                          </span>
                                        )}
                                        {task.brandName && (
                                          <span className="text-[11px] px-2 py-0.5 rounded-md border border-border bg-muted text-muted-foreground flex-shrink-0">
                                            {task.brandName}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-muted-foreground">
                                        {formattedDeadline && (
                                          <span className="inline-flex items-center gap-1">
                                            <CalendarDays className="h-3 w-3" />
                                            {formattedDeadline}
                                          </span>
                                        )}
                                        {priorityConfig && (
                                          <span
                                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${getPriorityBadgeClass(task.priority)}`}
                                          >
                                            <span>{priorityConfig.icon}</span>
                                            {priorityConfig.label}
                                          </span>
                                        )}
                                        {strategicPriorityConfig && (
                                          <span
                                            className={`px-2 py-0.5 rounded-md border ${strategicPriorityConfig.className}`}
                                          >
                                            {strategicPriorityConfig.label}
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    <span
                                      className={`text-xs px-2 py-0.5 rounded-full border flex-shrink-0 ${getStatusColor(task.status)}`}
                                    >
                                      {getStatusDisplay(task.status)}
                                    </span>
                                    <span
                                      className={`text-xs px-2 py-0.5 rounded-md border flex-shrink-0 ${
                                        task.corSyncStatus === "synced"
                                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                                          : task.corSyncStatus === "error"
                                            ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300"
                                            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                                      }`}
                                    >
                                      {task.corSyncStatus === "synced"
                                        ? "Publicado"
                                        : task.corSyncStatus === "error"
                                          ? "Error COR"
                                          : "Pendiente COR"}
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-md border border-primary/40 text-primary flex-shrink-0">
                                      <ExternalLink className="h-3 w-3" />
                                      {getCorActionLabel(task)}
                                    </span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
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
              className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors ml-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </WorkspaceLayout>
  );
}
