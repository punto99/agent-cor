"use client";

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskBriefContent } from "../task/TaskBriefContent";
import { ProjectBriefContent } from "../task/ProjectBriefContent";
import { EvaluationMessageList } from "../task/EvaluationMessages";
import { EvaluationInput } from "../task/EvaluationInput";
import { getStatusColor, getStatusDisplay } from "../task/types";
import type { Task, SelectedFile, EvaluationMessage } from "../task/types";
import { clientConfig } from "@/config/tenant.config";
import {
  X,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  RefreshCcw,
} from "lucide-react";

interface TaskDetailDialogProps {
  task: Task & {
    corSyncStatus?: string;
    corTaskId?: string;
    corProjectId?: number;
    corClientId?: number;
    corClientName?: string;
    corSyncError?: string;
    projectId?: Id<"projects">;
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
  const retryTask = useMutation(api.data.tasks.retryTaskSync);
  const retryProject = useMutation(api.data.projects.retryProjectSync);
  const pullFromCOR = useMutation(api.data.corInboundSync.startPullFromCOR);
  const createEvaluationThread = useMutation(
    api.data.evaluation.createEvaluationThread,
  );
  const sendEvaluationFile = useMutation(
    api.data.evaluation.sendEvaluationFile,
  );
  const uploadFile = useAction(api.data.files.uploadFile);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [activeTab, setActiveTab] = useState<"task" | "project" | "evaluation">(
    "task",
  );

  // === Evaluation state ===
  const [evaluationThreadId, setEvaluationThreadId] = useState<string | null>(
    null,
  );
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isSubmittingEval, setIsSubmittingEval] = useState(false);

  // Suscripción reactiva a la task para detectar cambios en corSyncStatus
  const liveTask = useQuery(api.data.tasks.getTask, { taskId: task._id });

  // Tracking: saber si el usuario inició la publicación desde ESTE dialog
  const publishInitiatedRef = useRef(false);

  // Obtener el proyecto asociado a la task (si tiene projectId)
  const project = useQuery(
    api.data.projects.getProject,
    task.projectId ? { projectId: task.projectId } : "skip",
  );

  // === Evaluation: thread existente + mensajes ===
  const existingEvalThread = useQuery(
    api.data.evaluation.getEvaluationThreadByTask,
    { taskId: task._id },
  );

  const evaluationMessages = useQuery(
    api.data.evaluation.listEvaluationMessages,
    evaluationThreadId
      ? {
          threadId: evaluationThreadId,
          paginationOpts: { cursor: null, numItems: 50 },
        }
      : "skip",
  );

  // Sincronizar evaluationThreadId cuando el query resuelve
  useEffect(() => {
    if (existingEvalThread) {
      setEvaluationThreadId(existingEvalThread.evaluationThreadId);
    }
  }, [existingEvalThread]);

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

  // === Evaluation handlers ===
  const handleStartEvaluation = async () => {
    try {
      const result = await createEvaluationThread({
        briefThreadId: task.threadId,
        taskId: task._id,
      });
      setEvaluationThreadId(result.evaluationThreadId);
      setActiveTab("evaluation");
    } catch (error) {
      console.error("Error creando thread de evaluación:", error);
    }
  };

  const handleSubmitEvaluation = async () => {
    if (selectedFiles.length === 0 || !evaluationThreadId) return;

    setIsSubmittingEval(true);
    try {
      const fileIds: string[] = [];
      for (const file of selectedFiles) {
        const uploadResult = await uploadFile({
          fileBase64: file.base64,
          filename: file.name,
        });
        fileIds.push(uploadResult.fileId);
      }

      await sendEvaluationFile({
        evaluationThreadId,
        briefThreadId: task.threadId,
        taskId: task._id,
        prompt:
          "Por favor evalúa este producto final y compáralo con el requerimiento original.",
        fileIds,
      });

      setSelectedFiles([]);
    } catch (error) {
      console.error("Error enviando evaluación:", error);
    } finally {
      setIsSubmittingEval(false);
    }
  };

  // Transformar mensajes de evaluación para el componente
  const evalMessageList: EvaluationMessage[] = (evaluationMessages?.page || [])
    .map((msg: any) => ({
      key: msg.key,
      role: msg.role,
      content: msg.parts || msg.text || "",
      text: msg.text,
      agentName: msg.agentName,
      status: msg.status,
    }))
    .filter((msg: EvaluationMessage) => {
      if (msg.role === "assistant") {
        const hasContent = Array.isArray(msg.content)
          ? msg.content.some((p) => p.text || p.url)
          : typeof msg.content === "string" && msg.content.trim() !== "";
        return hasContent || msg.status === "streaming";
      }
      return true;
    });

  const isEvaluatorThinking =
    evalMessageList.length > 0 &&
    evalMessageList[evalMessageList.length - 1]?.role === "user";

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
              {getStatusDisplay(task.status)}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border flex-shrink-0 px-6">
          <button
            onClick={() => setActiveTab("task")}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative cursor-pointer ${
              activeTab === "task"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            📋 Tarea
            {activeTab === "task" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
          {project && (
            <button
              onClick={() => setActiveTab("project")}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative cursor-pointer ${
                activeTab === "project"
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              📁 Proyecto
              {activeTab === "project" && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          )}
          <button
            onClick={() => {
              if (!evaluationThreadId) {
                handleStartEvaluation();
              } else {
                setActiveTab("evaluation");
              }
            }}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative cursor-pointer ${
              activeTab === "evaluation"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            ✨ Evaluar
            {activeTab === "evaluation" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        </div>

        {/* Body — Tab content */}
        <div
          className={`flex-1 min-h-0 ${
            activeTab === "evaluation"
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto"
          }`}
        >
          {activeTab === "task" && (
            <TaskBriefContent
              task={liveTask ?? task}
              editable={syncStatus !== "syncing"}
              syncStatus={syncStatus}
            />
          )}

          {activeTab === "project" && project && (
            <div className="p-4">
              {/* Banner de error de sync del proyecto */}
              {project.corSyncStatus === "retrying" && (
                <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                  <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                  <span>
                    Sincronizando proyecto con {toolName} (reintentando)...
                  </span>
                </div>
              )}
              {project.corSyncStatus === "error" && (
                <div className="flex flex-col gap-2 mb-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
                  <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    <span>Error al sincronizar proyecto con {toolName}</span>
                  </div>
                  {(project as any).corSyncError && (
                    <p className="text-xs text-muted-foreground ml-6">
                      {(project as any).corSyncError}
                    </p>
                  )}
                  <button
                    onClick={async () => {
                      try {
                        setIsRetrying(true);
                        setPublishError(null);
                        await retryProject({ projectId: project._id });
                      } catch (err: any) {
                        setPublishError(err.message || "Error al reintentar");
                      } finally {
                        setIsRetrying(false);
                      }
                    }}
                    disabled={isRetrying}
                    className="flex items-center gap-2 ml-6 px-3 py-1.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors disabled:opacity-50 cursor-pointer w-fit"
                  >
                    {isRetrying ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Reintentar sincronización
                  </button>
                </div>
              )}
              <ProjectBriefContent
                project={project}
                editable={syncStatus !== "syncing"}
                syncStatus={project.corSyncStatus || "pending"}
              />
            </div>
          )}

          {activeTab === "evaluation" && (
            <>
              <EvaluationMessageList
                messages={evalMessageList}
                isThinking={isEvaluatorThinking}
              />
              <EvaluationInput
                selectedFiles={selectedFiles}
                setSelectedFiles={setSelectedFiles}
                onSubmit={handleSubmitEvaluation}
                isSubmitting={isSubmittingEval}
              />
            </>
          )}
        </div>

        {/* Footer — Publish action (hidden on evaluation tab) */}
        {showPublishButton && activeTab !== "evaluation" && (
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

            {syncStatus === "retrying" && (
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 mb-3">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>
                  Sincronizando con {toolName} (reintentando)...
                  {(liveTask as any)?.corSyncError && (
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {(liveTask as any).corSyncError}
                    </span>
                  )}
                </span>
              </div>
            )}

            {syncStatus === "error" && (
              <div className="flex flex-col gap-2 mb-3">
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>Error al sincronizar con {toolName}</span>
                </div>
                {((liveTask as any)?.corSyncError || task.corSyncError) && (
                  <p className="text-xs text-muted-foreground ml-6">
                    {(liveTask as any)?.corSyncError || task.corSyncError}
                  </p>
                )}
                {/* Botón reintentar sync (cuando ya está publicada pero falló un edit sync) */}
                {task.corTaskId && (
                  <button
                    onClick={async () => {
                      try {
                        setIsRetrying(true);
                        setPublishError(null);
                        await retryTask({ taskId: task._id });
                      } catch (err: any) {
                        setPublishError(err.message || "Error al reintentar");
                      } finally {
                        setIsRetrying(false);
                      }
                    }}
                    disabled={isRetrying}
                    className="flex items-center gap-2 ml-6 px-3 py-1.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors disabled:opacity-50 cursor-pointer w-fit"
                  >
                    {isRetrying ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Reintentar sincronización
                  </button>
                )}
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
              {/* Show publish button only when task has never been published, or publish failed (no corTaskId yet) */}
              {syncStatus !== "synced" &&
                syncStatus !== "retrying" &&
                !task.corTaskId && (
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

              {/* Botón pull inbound: actualizar desde COR */}
              {syncStatus === "synced" && task.corTaskId && (
                <button
                  onClick={async () => {
                    try {
                      setIsPulling(true);
                      setPublishError(null);
                      await pullFromCOR({ taskId: task._id });
                    } catch (err: any) {
                      setPublishError(
                        err.message || `Error al actualizar desde ${toolName}`,
                      );
                    } finally {
                      setIsPulling(false);
                    }
                  }}
                  disabled={isPulling}
                  title={`Actualizar desde ${toolName}`}
                  className="p-2 border border-border rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer ml-auto"
                >
                  <RefreshCcw
                    className={`h-4 w-4 ${isPulling ? "animate-spin" : ""}`}
                  />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
