"use client";

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskBriefContent } from "../task/TaskBriefContent";
import { formatDate, getStatusColor, getPriorityConfig } from "../task/types";
import type { Task } from "../task/types";
import { clientConfig } from "@/config/tenant.config";
import {
  X,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

interface TaskDetailDialogProps {
  task: Task & {
    corSyncStatus?: string;
    corTaskId?: string;
    corProjectId?: number;
    corClientId?: number;
    corClientName?: string;
    corSyncError?: string;
  };
  onClose: () => void;
  /** Callback cuando la publicación se completa (éxito o error) */
  onPublishResult?: (result: { success: boolean; message: string }) => void;
}

/**
 * Dialog modal que muestra el detalle de una task con opción de publicar
 * al sistema externo (COR).
 *
 * Suscribe reactivamente al estado de la task para detectar cuando
 * la publicación finaliza (synced/error) y cerrar automáticamente.
 */
export function TaskDetailDialog({
  task,
  onClose,
  onPublishResult,
}: TaskDetailDialogProps) {
  const startPublish = useMutation(api.data.tasks.startPublishTaskToExternal);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  // Suscripción reactiva a la task para detectar cambios en corSyncStatus
  const liveTask = useQuery(api.data.tasks.getTask, { taskId: task._id });

  // Tracking: saber si el usuario inició la publicación desde ESTE dialog
  const publishInitiatedRef = useRef(false);

  const showPublishButton = clientConfig.ui.showPublishToExternalTool;
  const toolName = clientConfig.ui.externalToolName;

  // Obtener syncStatus en vivo (preferir liveTask, fallback a task prop)
  const syncStatus = liveTask?.corSyncStatus || task.corSyncStatus || "pending";

  // Detectar cuando la publicación finaliza (synced o error)
  useEffect(() => {
    if (!publishInitiatedRef.current) return;

    if (syncStatus === "synced") {
      // Publicación exitosa → notificar al padre y cerrar
      publishInitiatedRef.current = false;
      setIsPublishing(false);
      onPublishResult?.({
        success: true,
        message: `Tarea publicada exitosamente en ${toolName}`,
      });
      onClose();
    } else if (syncStatus === "error" && isPublishing) {
      // Error → mostrar en dialog, no cerrar
      publishInitiatedRef.current = false;
      setIsPublishing(false);
      const errorMsg =
        (liveTask as any)?.corSyncError || "Error desconocido al publicar";
      setPublishError(errorMsg);
      onPublishResult?.({
        success: false,
        message: errorMsg,
      });
    }
  }, [syncStatus, isPublishing, liveTask, onClose, onPublishResult, toolName]);

  const handlePublish = async () => {
    try {
      setPublishError(null);
      setIsPublishing(true);
      publishInitiatedRef.current = true;
      await startPublish({ taskId: task._id });
      // No cerramos aquí — esperamos a que el useEffect detecte el cambio reactivo
    } catch (err: any) {
      setIsPublishing(false);
      publishInitiatedRef.current = false;
      setPublishError(err.message || "Error al iniciar la publicación");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm cursor-pointer"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-card border border-border rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col mx-4 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">
              Detalle de Tarea
            </h2>
            {/* Status badge */}
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${getStatusColor(task.status)}`}
            >
              {task.status}
            </span>
            {/* Priority */}
            {getPriorityConfig(task.priority) && (
              <span
                className={`text-sm ${getPriorityConfig(task.priority)!.color}`}
              >
                {getPriorityConfig(task.priority)!.icon} {task.priority}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body — reusa TaskBriefContent */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <TaskBriefContent
            task={liveTask ?? task}
            editable={syncStatus !== "synced" && syncStatus !== "syncing"}
          />
        </div>

        {/* Footer — Publish action */}
        {showPublishButton && (
          <div className="px-6 py-4 border-t border-border flex-shrink-0 bg-muted/30">
            {/* Sync status info */}
            {syncStatus === "synced" && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mb-3">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Publicada en {toolName} exitosamente
                  {task.corTaskId && (
                    <span className="text-muted-foreground ml-1">
                      (Task ID: {task.corTaskId})
                    </span>
                  )}
                </span>
              </div>
            )}

            {syncStatus === "syncing" && (
              <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 mb-3">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Publicando en {toolName}...</span>
              </div>
            )}

            {syncStatus === "error" && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 mb-3">
                <AlertCircle className="h-4 w-4" />
                <span>
                  Error al publicar
                  {task.corSyncError && (
                    <span className="text-muted-foreground ml-1">
                      — {task.corSyncError}
                    </span>
                  )}
                </span>
              </div>
            )}

            {publishError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 mb-3">
                <AlertCircle className="h-4 w-4" />
                <span>{publishError}</span>
              </div>
            )}

            {/* COR Client info */}
            {task.corClientName && (
              <p className="text-xs text-muted-foreground mb-3">
                Cliente en {toolName}:{" "}
                <span className="font-medium text-foreground">
                  {task.corClientName}
                </span>
                {task.corClientId && ` (ID: ${task.corClientId})`}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              {syncStatus !== "synced" && (
                <button
                  onClick={handlePublish}
                  disabled={isPublishing || syncStatus === "syncing"}
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium cursor-pointer"
                >
                  {isPublishing || syncStatus === "syncing" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Publicando...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-4 w-4" />
                      {syncStatus === "error"
                        ? `Reintentar publicación en ${toolName}`
                        : `Crear Tarea en ${toolName}`}
                    </>
                  )}
                </button>
              )}

              <button
                onClick={onClose}
                className="px-4 py-2 border border-border rounded-lg hover:bg-muted transition-colors text-sm text-muted-foreground cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
