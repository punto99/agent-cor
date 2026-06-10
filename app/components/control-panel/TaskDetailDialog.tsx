"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskBriefContent } from "../task/TaskBriefContent";
import { ProjectBriefContent } from "../task/ProjectBriefContent";
import { EvaluationMessageList } from "../task/EvaluationMessages";
import { EvaluationInput } from "../task/EvaluationInput";
import { ConfirmDialog } from "@/app/components/ui/ConfirmDialog";
import { getStatusColor, getStatusDisplay } from "../task/types";
import type { Task, SelectedFile, EvaluationMessage } from "../task/types";
import { clientConfig } from "@/config/tenant.config";
import { base64ToBlob } from "@/app/lib/imageCompression";
import {
  X,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  RefreshCcw,
  Copy,
  Check,
  Search,
  FolderOpen,
  CalendarDays,
  Pencil,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface TaskDetailDialogProps {
  task: Task & {
    corSyncStatus?: string;
    corTaskId?: string;
    corProjectId?: number;
    corClientId?: number;
    corClientName?: string;
    clientId?: Id<"corClients">;
    clientBrandId?: Id<"clientBrands">;
    brandId?: number;
    brandName?: string;
    subBrandId?: Id<"subBrands">;
    productId?: number;
    subBrandName?: string;
    corSyncError?: string;
    projectId?: Id<"projects">;
    corTaskMissingInCOR?: boolean;
    corProjectMissingInCOR?: boolean;
    trelloCardId?: string;
    trelloCardUrl?: string;
    trelloSyncStatus?: string;
    trelloSyncError?: string;
  };
  onClose: () => void;
  /** Callback cuando la publicación se completa (éxito o error) */
  onPublishResult?: (result: { success: boolean; message: string }) => void;
}

type PublishProjectMode = "new" | "existing";

type CORProjectOption = {
  id: number;
  name: string;
  endDate?: string;
  status?: string;
  deliverables?: number;
};

type TaxonomySubBrandOption = {
  _id: Id<"subBrands">;
  name: string;
  corProductId: number;
};

type TaxonomyBrandOption = {
  _id: Id<"clientBrands">;
  name: string;
  corBrandId: number;
  subBrands: TaxonomySubBrandOption[];
};

type EditableTaxonomyItemProps = {
  brands: TaxonomyBrandOption[];
  brandId: string;
  subBrandId: string;
  editable: boolean;
  onApply: (value: {
    brandId: string;
    subBrandId: string;
  }) => void | Promise<void>;
};

function EditableTaxonomyItem({
  brands,
  brandId,
  subBrandId,
  editable,
  onApply,
}: EditableTaxonomyItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editBrandId, setEditBrandId] = useState(brandId);
  const [editSubBrandId, setEditSubBrandId] = useState(subBrandId);
  const [isApplying, setIsApplying] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectedBrand = brands.find((brand) => String(brand._id) === brandId);
  const selectedSubBrand = selectedBrand?.subBrands.find(
    (subBrand) => String(subBrand._id) === subBrandId,
  );
  const selectedEditBrand = brands.find(
    (brand) => String(brand._id) === editBrandId,
  );
  const editBrandHasSubBrands =
    (selectedEditBrand?.subBrands.length || 0) > 0;
  const hasChanges =
    editBrandId !== brandId || editSubBrandId !== subBrandId;
  const canApply =
    Boolean(editBrandId) &&
    (!editBrandHasSubBrands || Boolean(editSubBrandId)) &&
    hasChanges;

  useEffect(() => {
    if (isEditing && selectRef.current) {
      selectRef.current.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) {
      setEditBrandId(brandId);
      setEditSubBrandId(subBrandId);
    }
  }, [brandId, subBrandId, isEditing]);

  const handleStartEdit = () => {
    setEditBrandId(brandId);
    setEditSubBrandId(subBrandId);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditBrandId(brandId);
    setEditSubBrandId(subBrandId);
    setIsEditing(false);
  };

  const handleApply = async () => {
    if (!canApply) {
      setIsEditing(false);
      return;
    }

    try {
      setIsApplying(true);
      await onApply({
        brandId: editBrandId,
        subBrandId: editBrandHasSubBrands ? editSubBrandId : "",
      });
      setIsEditing(false);
    } catch {
      // El error se muestra desde el contenedor para mantener un único mensaje.
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="bg-card rounded-lg p-3 border border-border shadow-sm group/item">
      <div className="flex items-start gap-2">
        <span className="text-lg">🏷️</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">
            Categoría
          </p>
          {isEditing ? (
            <div className="mt-1">
              <select
                ref={selectRef}
                value={editBrandId}
                onChange={(event) => {
                  const nextBrandId = event.target.value;
                  const nextBrand = brands.find(
                    (brand) => String(brand._id) === nextBrandId,
                  );
                  setEditBrandId(nextBrandId);
                  setEditSubBrandId(
                    nextBrand?.subBrands.some(
                      (subBrand) => String(subBrand._id) === editSubBrandId,
                    )
                      ? editSubBrandId
                      : "",
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") handleCancel();
                }}
                disabled={isApplying}
                className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <option value="">Seleccionar categoría</option>
                {brands.map((brand) => (
                  <option key={brand._id} value={brand._id}>
                    {brand.name}
                  </option>
                ))}
              </select>

              {selectedEditBrand && editBrandHasSubBrands && (
                <div className="mt-2">
                  <p className="mb-1 text-xs text-muted-foreground uppercase tracking-wider">
                    Marca
                  </p>
                  <select
                    value={editSubBrandId}
                    onChange={(event) => setEditSubBrandId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") handleCancel();
                    }}
                    disabled={isApplying}
                    className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <option value="">Seleccionar marca</option>
                    {selectedEditBrand.subBrands.map((subBrand) => (
                      <option key={subBrand._id} value={subBrand._id}>
                        {subBrand.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={isApplying || !canApply}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  <Check className="h-3 w-3" />
                  {isApplying ? "Aplicando..." : "Aplicar"}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isApplying}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground disabled:opacity-50 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-foreground mt-0.5 truncate">
                {selectedBrand?.name || "Sin categoría"}
              </p>
              {selectedSubBrand && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Marca
                  </p>
                  <p className="text-sm text-foreground mt-0.5 truncate">
                    {selectedSubBrand.name}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        {editable && !isEditing && (
          <button
            type="button"
            onClick={handleStartEdit}
            className="opacity-0 group-hover/item:opacity-100 p-1.5 rounded-md hover:bg-muted transition-all text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
            title="Editar categoría y marca"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
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
  const updateTaskTaxonomy = useMutation(api.data.tasks.updateTaskTaxonomy);
  const retryProject = useMutation(api.data.projects.retryProjectSync);
  const softDeleteProject = useMutation(api.data.projects.softDeleteProject);
  const pullFromCOR = useMutation(api.data.corInboundSync.startPullFromCOR);
  const startPublishToTrello = useMutation(
    api.data.trello.startPublishTaskToTrello,
  );
  const createEvaluationThread = useMutation(
    api.data.evaluation.createEvaluationThread,
  );
  const sendEvaluationFile = useMutation(
    api.data.evaluation.sendEvaluationFile,
  );
  const generateUploadUrl = useMutation(api.data.files.generateUploadUrl);
  const registerUploadedFile = useAction(api.data.files.registerUploadedFile);
  const searchActiveCORProjects = useAction(
    api.data.projects.searchActiveCORProjectsForClient,
  );
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isPublishingToTrello, setIsPublishingToTrello] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isDeletingLocal, setIsDeletingLocal] = useState(false);
  const [confirmDeleteTaskOpen, setConfirmDeleteTaskOpen] = useState(false);
  const [confirmDeleteProjectOpen, setConfirmDeleteProjectOpen] =
    useState(false);
  const [publishProjectMode, setPublishProjectMode] =
    useState<PublishProjectMode>("new");
  const [isPublishProjectSectionOpen, setIsPublishProjectSectionOpen] =
    useState(true);
  const [existingProjectSearch, setExistingProjectSearch] = useState("");
  const [existingProjects, setExistingProjects] = useState<CORProjectOption[]>(
    [],
  );
  const [selectedExistingProjectId, setSelectedExistingProjectId] = useState<
    number | null
  >(null);
  const [isLoadingExistingProjects, setIsLoadingExistingProjects] =
    useState(false);
  const [existingProjectsError, setExistingProjectsError] = useState<
    string | null
  >(null);
  const [draftBrandId, setDraftBrandId] = useState<string>("");
  const [draftSubBrandId, setDraftSubBrandId] = useState<string>("");
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"task" | "project" | "evaluation">(
    "task",
  );

  // === Evaluation state ===
  const [evaluationThreadId, setEvaluationThreadId] = useState<string | null>(
    null,
  );
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isSubmittingEval, setIsSubmittingEval] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /** Copia un ID al clipboard y muestra feedback visual por 1.5s */
  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  // Suscripción reactiva a la task para detectar cambios en corSyncStatus
  const liveTask = useQuery(api.data.tasks.getTask, { taskId: task._id });

  // Tracking: saber si el usuario inició la publicación desde ESTE dialog
  const publishInitiatedRef = useRef(false);

  // Obtener el proyecto asociado a la task (si tiene projectId)
  const project = useQuery(
    api.data.projects.getProject,
    task.projectId ? { projectId: task.projectId } : "skip",
  );
  const taxonomyOptions = useQuery(api.data.tasks.listTaskTaxonomyOptions, {
    taskId: task._id,
  });

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
  const latestTaskEvaluation = useQuery(
    api.data.evaluation.getLatestTaskEvaluationByTask,
    { taskId: task._id },
  );

  // Sincronizar evaluationThreadId cuando el query resuelve
  useEffect(() => {
    if (existingEvalThread) {
      setEvaluationThreadId(existingEvalThread.evaluationThreadId);
    }
  }, [existingEvalThread]);

  const showPublishButton = clientConfig.ui.showPublishToExternalTool;
  const toolName = clientConfig.ui.externalToolName;
  const liveTaskCorClientId = (liveTask as any)?.corClientId ?? task.corClientId;
  const liveTaskTrelloCardId =
    (liveTask as any)?.trelloCardId ?? task.trelloCardId;
  const liveTaskTrelloCardUrl =
    (liveTask as any)?.trelloCardUrl ?? task.trelloCardUrl;
  const trelloSyncStatus =
    (liveTask as any)?.trelloSyncStatus ?? task.trelloSyncStatus ?? "pending";
  const isPublishedInTrello =
    trelloSyncStatus === "synced" ||
    Boolean(liveTaskTrelloCardId || liveTaskTrelloCardUrl);
  const showPublishToTrelloButton =
    typeof liveTaskCorClientId === "number" &&
    clientConfig.ui.trelloPublishCorClientIds.includes(liveTaskCorClientId) &&
    !isPublishedInTrello;

  // Obtener syncStatus en vivo (preferir liveTask, fallback a task prop)
  const syncStatus = liveTask?.corSyncStatus || task.corSyncStatus || "pending";
  const isPublishedInCOR =
    syncStatus === "synced" ||
    Boolean((liveTask as any)?.corTaskId ?? task.corTaskId);
  const liveCorTaskId = (liveTask as any)?.corTaskId ?? task.corTaskId;
  const canEditFromDialog =
    !isPublishedInCOR && syncStatus !== "syncing" && syncStatus !== "retrying";
  const localClientId = ((liveTask as any)?.clientId ??
    (task as any).clientId ??
    (project as any)?.clientId) as Id<"corClients"> | undefined;
  const projectSearchBrandId = ((liveTask as any)?.brandId ??
    task.brandId) as number | undefined;
  const projectSearchProductId = projectSearchBrandId
    ? (((liveTask as any)?.productId ?? task.productId) as number | undefined)
    : undefined;
  const canSelectPublishProject =
    canEditFromDialog &&
    syncStatus !== "synced" &&
    !liveCorTaskId &&
    Boolean(localClientId);
  const hasProposedProject = Boolean(project);
  const canPublishWithNewProject =
    canSelectPublishProject && hasProposedProject;
  const taxonomyBrands = (taxonomyOptions?.brands ||
    []) as TaxonomyBrandOption[];
  const liveClientBrandId =
    ((liveTask as any)?.clientBrandId ?? task.clientBrandId) || "";
  const liveSubBrandId =
    ((liveTask as any)?.subBrandId ?? task.subBrandId) || "";
  const filteredExistingProjects = useMemo(() => {
    const term = existingProjectSearch.trim().toLowerCase();
    if (!term) return existingProjects;
    return existingProjects.filter((item) =>
      item.name.toLowerCase().includes(term),
    );
  }, [existingProjectSearch, existingProjects]);
  const selectedExistingProject = existingProjects.find(
    (item) => item.id === selectedExistingProjectId,
  );
  const taskMissingInCOR = Boolean(
    (liveTask as any)?.corTaskMissingInCOR ?? task.corTaskMissingInCOR,
  );
  const projectMissingInCOR = Boolean(
    (project as any)?.corMissingInCOR ??
    (liveTask as any)?.corProjectMissingInCOR ??
    task.corProjectMissingInCOR,
  );

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

  useEffect(() => {
    if (!isPublishingToTrello) return;
    if (trelloSyncStatus === "synced") {
      setIsPublishingToTrello(false);
      setPublishError(null);
    } else if (trelloSyncStatus === "error") {
      setIsPublishingToTrello(false);
      setPublishError(
        (liveTask as any)?.trelloSyncError ||
          task.trelloSyncError ||
          "No se pudo publicar en Trello.",
      );
    }
  }, [isPublishingToTrello, liveTask, task.trelloSyncError, trelloSyncStatus]);

  useEffect(() => {
    setPublishProjectMode("new");
    setExistingProjectSearch("");
    setExistingProjects([]);
    setSelectedExistingProjectId(null);
    setExistingProjectsError(null);
  }, [task._id]);

  useEffect(() => {
    if (!canSelectPublishProject) return;
    if (task.projectId && project === undefined) return;
    if (task.projectId && project !== null) return;
    setPublishProjectMode("existing");
    if (existingProjects.length === 0 && !isLoadingExistingProjects) {
      void loadExistingProjects();
    }
  }, [
    canSelectPublishProject,
    existingProjects.length,
    isLoadingExistingProjects,
    project,
    task.projectId,
  ]);

  useEffect(() => {
    setDraftBrandId(String(liveClientBrandId || ""));
    setDraftSubBrandId(String(liveSubBrandId || ""));
    setTaxonomyError(null);
  }, [liveClientBrandId, liveSubBrandId, task._id]);

  const loadExistingProjects = async (filters?: {
    brandId?: number;
    productId?: number;
  }) => {
    if (!localClientId) return;

    try {
      setIsLoadingExistingProjects(true);
      setExistingProjectsError(null);
      const result = await searchActiveCORProjects({
        clientId: localClientId,
        brandId:
          filters && "brandId" in filters
            ? filters.brandId
            : projectSearchBrandId,
        productId:
          filters && "productId" in filters
            ? filters.productId
            : projectSearchProductId,
        perPage: 50,
      });
      setExistingProjects((result.projects || []) as CORProjectOption[]);
    } catch (err: any) {
      setExistingProjectsError(
        err.message || "No se pudieron cargar los proyectos existentes.",
      );
    } finally {
      setIsLoadingExistingProjects(false);
    }
  };

  const formatExistingProjectDate = (value?: string) => {
    if (!value) return "Sin fecha de fin";
    const date = new Date(`${value.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  const handleApplyTaxonomy = async (nextValue: {
    brandId: string;
    subBrandId: string;
  }) => {
    if (!nextValue.brandId) {
      setTaxonomyError("Selecciona una categoría.");
      throw new Error("Missing category");
    }

    const nextBrand = taxonomyBrands.find(
      (brand) => String(brand._id) === nextValue.brandId,
    );
    const normalizedSubBrandId =
      (nextBrand?.subBrands.length || 0) > 0 ? nextValue.subBrandId : "";

    if ((nextBrand?.subBrands.length || 0) > 0 && !normalizedSubBrandId) {
      setTaxonomyError("Selecciona una marca para esta categoría.");
      throw new Error("Missing brand");
    }

    try {
      setTaxonomyError(null);
      await updateTaskTaxonomy({
        taskId: task._id,
        clientBrandId: nextValue.brandId as Id<"clientBrands">,
        subBrandId: normalizedSubBrandId
          ? (normalizedSubBrandId as Id<"subBrands">)
          : undefined,
      });
      setDraftBrandId(nextValue.brandId);
      setDraftSubBrandId(normalizedSubBrandId);
      setExistingProjects([]);
      setSelectedExistingProjectId(null);
      setExistingProjectsError(null);
      if (publishProjectMode === "existing") {
        const nextSubBrand = nextBrand?.subBrands.find(
          (subBrand) => String(subBrand._id) === normalizedSubBrandId,
        );
        await loadExistingProjects({
          brandId: nextBrand?.corBrandId,
          productId: nextSubBrand?.corProductId,
        });
      }
    } catch (err: any) {
      setTaxonomyError(
        err.message || "No se pudo actualizar la marca de la task.",
      );
      throw err;
    }
  };

  const handlePublish = async () => {
    try {
      setPublishError(null);
      if (publishProjectMode === "existing" && !selectedExistingProjectId) {
        setPublishError("Selecciona un proyecto existente para publicar.");
        return;
      }
      if (publishProjectMode === "new" && !canPublishWithNewProject) {
        setPublishError(
          "No hay un proyecto nuevo propuesto para esta tarea. Selecciona un proyecto existente.",
        );
        setPublishProjectMode("existing");
        if (existingProjects.length === 0) {
          void loadExistingProjects();
        }
        return;
      }
      setIsPublishing(true);
      publishInitiatedRef.current = true;
      await startPublish({
        taskId: task._id,
        existingCorProjectId:
          publishProjectMode === "existing"
            ? selectedExistingProjectId ?? undefined
            : undefined,
      });
      // No cerramos aquí — esperamos a que el useEffect detecte el cambio reactivo
    } catch (err: any) {
      setIsPublishing(false);
      publishInitiatedRef.current = false;
      setPublishError(err.message || "Error al iniciar la publicación");
    }
  };

  const taxonomyItems =
    taxonomyOptions && taxonomyBrands.length > 0 ? (
      <>
        <EditableTaxonomyItem
          brands={taxonomyBrands}
          brandId={draftBrandId}
          subBrandId={draftSubBrandId}
          editable={canEditFromDialog}
          onApply={handleApplyTaxonomy}
        />

        {taxonomyError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{taxonomyError}</span>
          </div>
        )}
      </>
    ) : null;

  const handlePublishToTrello = async () => {
    try {
      setPublishError(null);
      setIsPublishingToTrello(true);
      await startPublishToTrello({ taskId: task._id });
    } catch (err: any) {
      setPublishError(err.message || "Error al publicar en Trello");
      setIsPublishingToTrello(false);
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
        // 1. Convertir base64 (preview) a Blob binario
        const blob = base64ToBlob(file.base64);
        // Para imágenes, blob.type refleja el formato real tras compresión (JPEG)
        const actualMimeType = blob.type || file.type;

        // 2. Subir binario directo a Convex Storage
        const uploadUrl = await generateUploadUrl();
        const uploadResp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": actualMimeType },
          body: blob,
        });
        if (!uploadResp.ok) throw new Error("Error subiendo archivo a storage");
        const { storageId } = await uploadResp.json();

        // 3. Registrar en el sistema de archivos del agente
        const uploadResult = await registerUploadedFile({
          storageId,
          filename: file.name,
          mimeType: actualMimeType,
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
    latestTaskEvaluation?.status === "processing" || isSubmittingEval;
  const evaluationErrorMessage =
    latestTaskEvaluation?.status === "failed" && !isEvaluatorThinking
      ? latestTaskEvaluation.error ||
        "El evaluador no pudo generar una respuesta."
      : null;
  const shouldDeleteBoth = taskMissingInCOR && projectMissingInCOR && !!project;

  const handleConfirmDeleteTask = async () => {
    try {
      setIsDeletingLocal(true);
      if (shouldDeleteBoth && project) {
        await softDeleteProject({ projectId: project._id });
        onPublishResult?.({
          success: true,
          message: "Tarea y proyecto eliminados localmente del panel.",
        });
        onClose();
      } else {
        onPublishResult?.({
          success: true,
          message:
            "La tarea no se elimina del panel para conservar acceso al proyecto.",
        });
      }
    } catch (err: any) {
      setPublishError(err.message || "Error al eliminar la tarea localmente");
    } finally {
      setIsDeletingLocal(false);
      setConfirmDeleteTaskOpen(false);
    }
  };

  const handleConfirmDeleteProject = async () => {
    if (!project) return;
    try {
      setIsDeletingLocal(true);
      await softDeleteProject({ projectId: project._id });
      onPublishResult?.({
        success: true,
        message: "Proyecto eliminado localmente del panel.",
      });
      onClose();
    } catch (err: any) {
      setPublishError(
        err.message || "Error al eliminar el proyecto localmente",
      );
    } finally {
      setIsDeletingLocal(false);
      setConfirmDeleteProjectOpen(false);
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
            <div>
              {taskMissingInCOR && (
                <div className="mx-6 mt-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <span>
                    Esta tarea no fue encontrada en {toolName}, posiblemente fue
                    eliminada.
                    {shouldDeleteBoth ? (
                      <>
                        {" "}
                        Como el proyecto también no fue encontrado, puedes
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteTaskOpen(true)}
                          className="ml-1 underline underline-offset-2 hover:text-red-800 cursor-pointer"
                        >
                          eliminar ambos aquí
                        </button>
                        .
                      </>
                    ) : (
                      <>
                        {" "}
                        Se mantiene en el panel para conservar acceso al
                        proyecto.
                      </>
                    )}
                  </span>
                </div>
              )}
              {taskMissingInCOR ? (
                <div className="mx-6 mt-4 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
                  El contenido de esta tarea no está disponible porque no fue
                  encontrada en {toolName}.
                </div>
              ) : (
                <>
                  {/* ID de la task para edición via agente */}
                  <div className="mx-6 mt-4 mb-2 flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                    <span className="font-medium">ID para edición:</span>
                    <code className="font-mono text-foreground/80 select-all">
                      {task._id}
                    </code>
                    <button
                      onClick={() => handleCopyId(task._id)}
                      className="ml-auto p-1 hover:bg-muted rounded transition-colors cursor-pointer"
                      title="Copiar ID"
                    >
                      {copiedId === task._id ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <TaskBriefContent
                    task={liveTask ?? task}
                    editable={canEditFromDialog}
                    syncStatus={syncStatus}
                    afterTitleItems={taxonomyItems}
                  />
                </>
              )}
            </div>
          )}

          {activeTab === "project" && project && (
            <div className="p-4">
              {projectMissingInCOR && (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <span>
                    Este proyecto no fue encontrado en {toolName}, posiblemente
                    fue eliminado. Puedes
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteProjectOpen(true)}
                      className="ml-1 underline underline-offset-2 hover:text-red-800 cursor-pointer"
                    >
                      Eliminar aquí
                    </button>
                    .
                  </span>
                </div>
              )}
              {/* ID del proyecto para edición via agente */}
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                <span className="font-medium">ID para edición:</span>
                <code className="font-mono text-foreground/80 select-all">
                  {project._id}
                </code>
                <button
                  onClick={() => handleCopyId(project._id)}
                  className="ml-auto p-1 hover:bg-muted rounded transition-colors cursor-pointer"
                  title="Copiar ID"
                >
                  {copiedId === project._id ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
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
                editable={canEditFromDialog}
                syncStatus={project.corSyncStatus || "pending"}
              />
            </div>
          )}

          {activeTab === "evaluation" && (
            <>
              <EvaluationMessageList
                messages={evalMessageList}
                isThinking={isEvaluatorThinking}
                errorMessage={evaluationErrorMessage}
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

            {isPublishedInTrello && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mb-3">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Publicada en Trello exitosamente
                  {liveTaskTrelloCardUrl && (
                    <a
                      href={liveTaskTrelloCardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                    >
                      Ver card
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
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
                {liveCorTaskId && (
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

            {canSelectPublishProject && (
              <div className="mb-4 rounded-lg border border-border bg-card/70 p-3">
                <button
                  type="button"
                  onClick={() =>
                    setIsPublishProjectSectionOpen((open) => !open)
                  }
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 text-left text-sm font-medium text-foreground outline-none transition-colors hover:text-primary ${
                    isPublishProjectSectionOpen ? "mb-2" : ""
                  }`}
                  aria-expanded={isPublishProjectSectionOpen}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
                    <span className="truncate">Proyecto en {toolName}</span>
                  </span>
                  {isPublishProjectSectionOpen ? (
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  )}
                </button>

                {isPublishProjectSectionOpen && (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!canPublishWithNewProject) return;
                          setPublishProjectMode("new");
                          setSelectedExistingProjectId(null);
                          setPublishError(null);
                        }}
                        disabled={!canPublishWithNewProject}
                        title={
                          canPublishWithNewProject
                            ? undefined
                            : "No hay proyecto nuevo creado para esta tarea."
                        }
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          !canPublishWithNewProject
                            ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground opacity-70"
                            : publishProjectMode === "new"
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border bg-background hover:bg-muted"
                        }`}
                      >
                        <span className="block font-medium">
                          Crear proyecto nuevo
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {canPublishWithNewProject
                            ? "Usa el proyecto propuesto por el agente."
                            : "No hay proyecto nuevo creado para esta tarea."}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPublishProjectMode("existing");
                          setPublishError(null);
                          if (existingProjects.length === 0) {
                            void loadExistingProjects();
                          }
                        }}
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                          publishProjectMode === "existing"
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background hover:bg-muted"
                        }`}
                      >
                        <span className="block font-medium">
                          Usar proyecto existente
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Publica la tarea dentro de un proyecto activo.
                        </span>
                      </button>
                    </div>

                    {publishProjectMode === "existing" && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                          <Search className="h-4 w-4 text-muted-foreground" />
                          <input
                            value={existingProjectSearch}
                            onChange={(event) =>
                              setExistingProjectSearch(event.target.value)
                            }
                            placeholder="Buscar proyecto existente"
                            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                          />
                          <button
                            type="button"
                            onClick={() => void loadExistingProjects()}
                            disabled={isLoadingExistingProjects}
                            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {isLoadingExistingProjects
                              ? "Cargando..."
                              : "Actualizar"}
                          </button>
                        </div>

                        {existingProjectsError && (
                          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                            <span>{existingProjectsError}</span>
                          </div>
                        )}

                        <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                          {isLoadingExistingProjects && (
                            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Cargando proyectos activos...
                            </div>
                          )}

                          {!isLoadingExistingProjects &&
                            filteredExistingProjects.length === 0 && (
                              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                                No hay proyectos activos para esta búsqueda.
                              </div>
                            )}

                          {!isLoadingExistingProjects &&
                            filteredExistingProjects.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                  setSelectedExistingProjectId(item.id);
                                  setPublishError(null);
                                }}
                                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                                  selectedExistingProjectId === item.id
                                    ? "border-primary bg-primary/10"
                                    : "border-border bg-background hover:bg-muted"
                                }`}
                              >
                                <span className="block text-sm font-medium text-foreground">
                                  {item.name}
                                </span>
                                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                  <span>ID COR: {item.id}</span>
                                  <span className="inline-flex items-center gap-1">
                                    <CalendarDays className="h-3 w-3" />
                                    {formatExistingProjectDate(item.endDate)}
                                  </span>
                                  {typeof item.deliverables === "number" && (
                                    <span>{item.deliverables} entregables</span>
                                  )}
                                </span>
                              </button>
                            ))}
                        </div>

                        {selectedExistingProject && (
                          <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                            Se publicará dentro de{" "}
                            <span className="font-medium text-foreground">
                              {selectedExistingProject.name}
                            </span>
                            .
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              {/* Show publish button only when task has never been published, or publish failed (no corTaskId yet) */}
              {syncStatus !== "synced" &&
                syncStatus !== "retrying" &&
                !liveCorTaskId && (
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

              {showPublishToTrelloButton && (
                <button
                  type="button"
                  onClick={handlePublishToTrello}
                  disabled={
                    isPublishingToTrello || trelloSyncStatus === "syncing"
                  }
                  className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-70 cursor-pointer"
                >
                  {isPublishingToTrello || trelloSyncStatus === "syncing" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Publicando en Trello...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-4 w-4" />
                      {trelloSyncStatus === "error"
                        ? "Reintentar publicación en Trello"
                        : "Publicar en Trello"}
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

      <ConfirmDialog
        open={confirmDeleteTaskOpen}
        onClose={() => setConfirmDeleteTaskOpen(false)}
        title={
          shouldDeleteBoth
            ? "Eliminar tarea y proyecto del panel"
            : "Conservar tarea para acceso al proyecto"
        }
        description={
          shouldDeleteBoth
            ? `Se eliminarán esta tarea y su proyecto localmente en una sola operación. No modifica ${toolName}.`
            : `La tarea se mantendrá visible en el panel para conservar acceso al proyecto, porque el proyecto sí existe en ${toolName}.`
        }
        confirmLabel={shouldDeleteBoth ? "Eliminar ambos" : "Entendido"}
        isLoading={isDeletingLocal}
        onConfirm={handleConfirmDeleteTask}
      />

      <ConfirmDialog
        open={confirmDeleteProjectOpen}
        onClose={() => setConfirmDeleteProjectOpen(false)}
        title="Eliminar proyecto del panel"
        description={`Esta acción elimina el proyecto solo en esta aplicación. No modifica ${toolName}.`}
        confirmLabel="Eliminar proyecto"
        isLoading={isDeletingLocal}
        onConfirm={handleConfirmDeleteProject}
      />
    </div>
  );
}
