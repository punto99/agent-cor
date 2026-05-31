"use client";

import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import {
  Task,
  SelectedFile,
  EvaluationMessage,
  getStatusColor,
  getPriorityConfig,
} from "./components/task";
import {
  TaskBriefContent,
  EmptyTaskState,
  LoadingTaskState,
} from "./components/task";
import { EvaluationMessageList, EvaluationInput } from "./components/task";
import { CloseButton, StatusBadge, PriorityBadge } from "./components/task";

interface TaskPanelProps {
  threadId: string | null;
  onClose?: () => void;
}

type TabType = "task" | "evaluation";

export default function TaskPanel({ threadId, onClose }: TaskPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>("task");
  const [evaluationThreadId, setEvaluationThreadId] = useState<string | null>(
    null,
  );
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Obtener task asociada al thread actual
  const task = useQuery(
    api.data.tasks.getTaskByThread,
    threadId ? { threadId } : "skip",
  ) as Task | null | undefined;

  // Obtener thread de evaluación existente para la task actual
  const existingEvaluationThread = useQuery(
    api.data.evaluation.getEvaluationThreadByTask,
    task ? { taskId: task._id } : "skip",
  );

  // Mutations para evaluación
  const createEvaluationThread = useMutation(
    api.data.evaluation.createEvaluationThread,
  );
  const sendEvaluationFile = useMutation(api.data.evaluation.sendEvaluationFile);
  const uploadFile = useAction(api.data.files.uploadFile);

  // Sincronizar evaluationThreadId cuando cambia la task
  useEffect(() => {
    if (task && existingEvaluationThread) {
      if (existingEvaluationThread.originalThreadId === threadId) {
        setEvaluationThreadId(existingEvaluationThread.evaluationThreadId);
      } else {
        setEvaluationThreadId(null);
        setActiveTab("task");
        setSelectedFiles([]);
      }
    } else if (task && existingEvaluationThread === null) {
      setEvaluationThreadId(null);
      setActiveTab("task");
      setSelectedFiles([]);
    }
  }, [task?._id, existingEvaluationThread, threadId]);

  // Obtener mensajes de evaluación si existe el thread
  const evaluationMessages = useQuery(
    api.data.evaluation.listEvaluationMessages,
    evaluationThreadId
      ? {
          threadId: evaluationThreadId,
          paginationOpts: { cursor: null, numItems: 50 },
        }
      : "skip",
  );
  const latestTaskEvaluation = useQuery(
    api.data.evaluation.getLatestTaskEvaluationByTask,
    task ? { taskId: task._id } : "skip",
  );

  // Handler para iniciar evaluación
  const handleStartEvaluation = async () => {
    if (!threadId || !task) return;
    try {
      const result = await createEvaluationThread({
        briefThreadId: threadId,
        taskId: task._id,
      });
      setEvaluationThreadId(result.evaluationThreadId);
      setActiveTab("evaluation");
    } catch (error) {
      console.error("Error creando thread de evaluación:", error);
    }
  };

  // Handler para enviar evaluación
  const handleSubmitEvaluation = async () => {
    if (selectedFiles.length === 0 || !evaluationThreadId || !threadId || !task)
      return;

    setIsSubmitting(true);
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
        briefThreadId: threadId,
        taskId: task._id,
        prompt:
          "Por favor evalúa este producto final y compáralo con el requerimiento original.",
        fileIds: fileIds,
      });

      setSelectedFiles([]);
    } catch (error) {
      console.error("Error enviando evaluación:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Estado de carga
  if (threadId && task === undefined) {
    return <LoadingTaskState />;
  }

  // No hay task aún
  if (!task) {
    return <EmptyTaskState onClose={onClose} />;
  }

  // Extraer mensajes de evaluación
  const evaluationMessageList: EvaluationMessage[] = (
    evaluationMessages?.page || []
  )
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

  // Verificar si el evaluador está pensando
  const isEvaluatorThinking =
    latestTaskEvaluation?.status === "processing" || isSubmitting;
  const evaluationErrorMessage =
    latestTaskEvaluation?.status === "failed" && !isEvaluatorThinking
      ? latestTaskEvaluation.error ||
        "El evaluador no pudo generar una respuesta."
      : null;

  const statusColor = getStatusColor(task.status);
  const priorityConfig = getPriorityConfig(task.priority);

  return (
    <div className="h-full bg-card flex flex-col overflow-hidden">
      {/* Header con Tabs - Fijo */}
      <div className="p-4 border-b border-border flex-shrink-0 bg-muted/50">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            📋 Tareas
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {isExpanded ? "▼" : "▶"}
            </button>
            {onClose && <CloseButton onClick={onClose} />}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("task")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
              activeTab === "task"
                ? "bg-card text-primary shadow-sm"
                : "text-muted-foreground hover:bg-card/50"
            }`}
          >
            📋 Brief
          </button>
          <button
            onClick={() => {
              if (!evaluationThreadId && task) {
                handleStartEvaluation();
              } else {
                setActiveTab("evaluation");
              }
            }}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
              activeTab === "evaluation"
                ? "bg-card text-primary shadow-sm"
                : "text-muted-foreground hover:bg-card/50"
            }`}
          >
            ✨ Evaluar
          </button>
        </div>

        {/* Status y prioridad (solo en tab task) */}
        {activeTab === "task" && (
          <div className="flex items-center gap-2 mt-3">
            <StatusBadge status={task.status} colorClass={statusColor} />
            <PriorityBadge priority={task.priority} config={priorityConfig} />
          </div>
        )}
      </div>

      {/* Content - Tab Task - Con scroll propio */}
      {isExpanded && activeTab === "task" && <TaskBriefContent task={task} />}

      {/* Content - Tab Evaluación - Con scroll propio */}
      {isExpanded && activeTab === "evaluation" && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-background">
          <EvaluationMessageList
            messages={evaluationMessageList}
            isThinking={isEvaluatorThinking}
            errorMessage={evaluationErrorMessage}
          />
          <EvaluationInput
            selectedFiles={selectedFiles}
            setSelectedFiles={setSelectedFiles}
            onSubmit={handleSubmitEvaluation}
            isSubmitting={isSubmitting}
          />
        </div>
      )}

      {/* Footer con acciones (solo en tab task) */}
      {activeTab === "task" && (
        <div className="p-4 border-t border-border flex-shrink-0 bg-card">
          <button
            onClick={handleStartEvaluation}
            className="w-full py-2.5 px-4 bg-primary hover:bg-primary/90
                       text-primary-foreground rounded-lg transition-all flex items-center 
                       justify-center gap-2 font-medium shadow-md hover:shadow-lg"
          >
            <span>✨</span>
            Evaluar resultado
          </button>
        </div>
      )}
    </div>
  );
}
