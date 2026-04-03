"use client";

import { useState, useEffect } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskCard } from "../../components/control-panel/TaskCard";
import { TaskDetailDialog } from "../../components/control-panel/TaskDetailDialog";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";
import { LoadingScreen } from "../../components/LoadingScreen";
import { useMutation } from "convex/react";
import {
  LayoutDashboard,
  Filter,
  CheckCircle2,
  AlertCircle,
  X,
} from "lucide-react";

// Tipo local que extiende Task con los campos de sincronización
// (el schema los tiene pero el type de task/types.ts no los incluye)
interface FullTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;
  deadline?: string;
  priority?: number; // 0=Low, 1=Medium, 2=High, 3=Urgent
  status: string;
  threadId: string;
  createdBy?: string;
  corTaskId?: string;
  corProjectId?: number;
  corSyncStatus?: string;
  corSyncError?: string;
  corSyncedAt?: number;
  corClientId?: number;
  corClientName?: string;
  corDescriptionHash?: string;
  lastLocalEditAt?: number;
}

export default function ControlPanelPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );
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

  // Obtener tasks del usuario
  const tasks = useQuery(api.data.tasks.listMyTasks, {
    status: statusFilter,
  }) as FullTask[] | undefined;

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

  // Loading state
  if (threadsStatus === "LoadingFirstPage") {
    return <LoadingScreen />;
  }

  const statusOptions = [
    { value: undefined, label: "Todas" },
    { value: "nueva", label: "Nueva" },
    { value: "en_proceso", label: "En proceso" },
    { value: "estancada", label: "Estancada" },
    { value: "finalizada", label: "Finalizada" },
  ];

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={handleSelectThread}
    >
      <div className="h-full flex flex-col bg-background">
        {/* Page Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <LayoutDashboard className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold text-foreground">
              Panel de Control
            </h1>
            {tasks && (
              <span className="text-sm text-muted-foreground">
                ({tasks.length} tarea{tasks.length !== 1 ? "s" : ""})
              </span>
            )}
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <select
              value={statusFilter || ""}
              onChange={(e) => setStatusFilter(e.target.value || undefined)}
              className="text-sm bg-card border border-border rounded-lg px-3 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {statusOptions.map((opt) => (
                <option key={opt.label} value={opt.value || ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Tasks Grid */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {!tasks ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-pulse text-muted-foreground">
                Cargando tareas...
              </div>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="text-6xl mb-4">📋</div>
              <h3 className="text-lg font-medium text-foreground mb-2">
                No hay tareas aún
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs">
                Las tareas aparecerán aquí una vez que las crees a través del
                chat con el asistente.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {tasks.map((task) => (
                <TaskCard
                  key={task._id}
                  task={task}
                  onClick={() => setSelectedTask(task)}
                />
              ))}
            </div>
          )}
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
