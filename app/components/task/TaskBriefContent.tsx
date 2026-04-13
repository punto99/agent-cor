"use client";

import { useState, useRef, useEffect } from "react";
import type { Task } from "./types";
import { formatDate, getStatusColor } from "./types";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Pencil, Check, X as XIcon, Cloud, Loader2 } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

// ==================== EditableInfoItem ====================

interface EditableInfoItemProps {
  icon: string;
  label: string;
  value: string;
  fieldKey: string;
  multiline?: boolean;
  editable?: boolean;
  onSave?: (fieldKey: string, newValue: string) => Promise<void>;
}

/**
 * Componente para mostrar un item de información con icono.
 * Si editable=true, muestra un ícono de lápiz que permite editar en línea.
 */
function EditableInfoItem({
  icon,
  label,
  value,
  fieldKey,
  multiline = false,
  editable = false,
  onSave,
}: EditableInfoItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // Poner el cursor al final del texto
      const len = editValue.length;
      if (inputRef.current instanceof HTMLTextAreaElement) {
        inputRef.current.setSelectionRange(len, len);
      }
    }
  }, [isEditing]);

  // Sync editValue when external value changes (e.g., after another save)
  useEffect(() => {
    if (!isEditing) setEditValue(value);
  }, [value, isEditing]);

  const handleStartEdit = () => {
    setEditValue(value);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!onSave) return;
    const trimmed = editValue.trim();
    if (trimmed === value) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(fieldKey, trimmed);
      setIsEditing(false);
    } catch (err) {
      console.error("Error saving field:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Enter" && multiline && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div className="bg-card rounded-lg p-3 border border-border shadow-sm group/item">
      <div className="flex items-start gap-2">
        <span className="text-lg">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          {isEditing ? (
            <div className="mt-1">
              {multiline ? (
                <textarea
                  ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={3}
                  className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              ) : (
                <input
                  ref={inputRef as React.RefObject<HTMLInputElement>}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              )}
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <Check className="h-3 w-3" />
                  {isSaving ? "Guardando..." : "Guardar"}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground cursor-pointer"
                >
                  <XIcon className="h-3 w-3" />
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <p
              className={`text-sm text-foreground mt-0.5 ${
                multiline ? "whitespace-pre-wrap" : "truncate"
              }`}
            >
              {value}
            </p>
          )}
        </div>
        {editable && !isEditing && (
          <button
            onClick={handleStartEdit}
            className="opacity-0 group-hover/item:opacity-100 p-1.5 rounded-md hover:bg-muted transition-all text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
            title={`Editar ${label.toLowerCase()}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ==================== EditableSelectItem ====================

interface SelectOption {
  value: string;
  label: string;
}

interface EditableSelectItemProps {
  icon: string;
  label: string;
  value: string;
  displayValue: string;
  fieldKey: string;
  options: SelectOption[];
  editable?: boolean;
  colorFn?: (value: string) => string;
  onSave?: (fieldKey: string, newValue: string) => Promise<void>;
}

/**
 * Componente para mostrar un item con dropdown de selección.
 * Si editable=true, muestra un lápiz que abre un <select>.
 */
function EditableSelectItem({
  icon,
  label,
  value,
  displayValue,
  fieldKey,
  options,
  editable = false,
  colorFn,
  onSave,
}: EditableSelectItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (isEditing && selectRef.current) {
      selectRef.current.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setEditValue(value);
  }, [value, isEditing]);

  const handleStartEdit = () => {
    setEditValue(value);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!onSave) return;
    if (editValue === value) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(fieldKey, editValue);
      setIsEditing(false);
    } catch (err) {
      console.error("Error saving field:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const colorClass = colorFn ? colorFn(isEditing ? editValue : value) : "";

  return (
    <div className="bg-card rounded-lg p-3 border border-border shadow-sm group/item">
      <div className="flex items-start gap-2">
        <span className="text-lg">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          {isEditing ? (
            <div className="mt-1">
              <select
                ref={selectRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") handleCancel();
                }}
                className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <Check className="h-3 w-3" />
                  {isSaving ? "Guardando..." : "Guardar"}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground cursor-pointer"
                >
                  <XIcon className="h-3 w-3" />
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-0.5">
              {colorClass ? (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full border ${colorClass}`}
                >
                  {displayValue}
                </span>
              ) : (
                <p className="text-sm text-foreground">{displayValue}</p>
              )}
            </div>
          )}
        </div>
        {editable && !isEditing && (
          <button
            onClick={handleStartEdit}
            className="opacity-0 group-hover/item:opacity-100 p-1.5 rounded-md hover:bg-muted transition-all text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
            title={`Editar ${label.toLowerCase()}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ==================== Read-only InfoItem (backward compatible) ====================

interface InfoItemProps {
  icon: string;
  label: string;
  value: string;
  multiline?: boolean;
}

/**
 * Componente para mostrar un item de información con icono (solo lectura)
 */
export function InfoItem({
  icon,
  label,
  value,
  multiline = false,
}: InfoItemProps) {
  return (
    <div className="bg-card rounded-lg p-3 border border-border shadow-sm">
      <div className="flex items-start gap-2">
        <span className="text-lg">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          <p
            className={`text-sm text-foreground mt-0.5 ${
              multiline ? "whitespace-pre-wrap" : "truncate"
            }`}
          >
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

// ==================== TaskBriefContent ====================

interface TaskBriefContentProps {
  task: Task;
  /** Si true, muestra íconos de edición en cada campo */
  editable?: boolean;
  /** Estado de sincronización con COR */
  syncStatus?: string;
}

// Opciones de prioridad para COR (0=Baja, 1=Media, 2=Alta, 3=Urgente)
const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "Baja" },
  { value: "1", label: "Media" },
  { value: "2", label: "Alta" },
  { value: "3", label: "Urgente" },
];

// Prioridad: icono + label para mostrar cuando ya está seleccionada
const PRIORITY_DISPLAY: Record<
  number,
  { icon: string; label: string; color: string }
> = {
  0: {
    icon: "↓",
    label: "Baja",
    color: "bg-muted text-muted-foreground border-border",
  },
  1: {
    icon: "→",
    label: "Media",
    color:
      "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  },
  2: {
    icon: "↑",
    label: "Alta",
    color:
      "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800",
  },
  3: {
    icon: "⚠",
    label: "Urgente",
    color:
      "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
  },
};

const getPriorityColor = (value: string): string => {
  const cfg = PRIORITY_DISPLAY[parseInt(value)];
  return cfg?.color || PRIORITY_DISPLAY[1].color;
};

// Opciones de estado para COR
// Códigos reales del API: nueva, en_proceso, en_revision, en_diseno, estancada, finalizada
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "nueva", label: "Nueva" },
  { value: "en_proceso", label: "En Proceso" },
  { value: "en_revision", label: "En Revisión" },
  { value: "en_diseno", label: "Ajustes" },
  { value: "estancada", label: "Suspendida" },
  { value: "finalizada", label: "Finalizada" },
];

// Mapa de estado display
const STATUS_DISPLAY: Record<string, string> = {
  nueva: "Nueva",
  en_proceso: "En Proceso",
  en_revision: "En Revisión",
  en_diseno: "Ajustes",
  estancada: "Suspendida",
  finalizada: "Finalizada",
};

/**
 * Contenido del brief de una tarea.
 * Si editable=true, cada campo tiene un ícono de lápiz para editar en línea.
 */
export function TaskBriefContent({
  task,
  editable = false,
  syncStatus,
}: TaskBriefContentProps) {
  const updateTask = useMutation(api.data.tasks.updateTaskFields);
  const attachments = useQuery(api.data.tasks.getTaskAttachmentsPublic, {
    taskId: task._id,
  });

  // Handler genérico para guardar un campo
  const handleSaveField = async (fieldKey: string, newValue: string) => {
    // Para priority, convertir el string del select a número
    if (fieldKey === "priority") {
      const numValue = parseInt(newValue);
      await updateTask({
        taskId: task._id,
        updates: { priority: isNaN(numValue) ? 1 : numValue },
      });
      showSyncFeedback();
      return;
    }
    // Para status, el valor ya viene como string directo del select
    if (fieldKey === "status") {
      await updateTask({
        taskId: task._id,
        updates: { status: newValue },
      });
      showSyncFeedback();
      return;
    }
    await updateTask({
      taskId: task._id,
      updates: { [fieldKey]: newValue },
    });
    showSyncFeedback();
  };

  // Sync feedback indicator — muestra brevemente que se está sincronizando con COR
  const [showingSyncFeedback, setShowingSyncFeedback] = useState(false);
  const syncFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSyncFeedback = () => {
    if (syncStatus !== "synced") return; // Solo mostrar para tasks publicadas en COR
    setShowingSyncFeedback(true);
    if (syncFeedbackTimer.current) clearTimeout(syncFeedbackTimer.current);
    syncFeedbackTimer.current = setTimeout(() => {
      setShowingSyncFeedback(false);
    }, 3000);
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (syncFeedbackTimer.current) clearTimeout(syncFeedbackTimer.current);
    };
  }, []);

  // Estado de edición de la descripción
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState(task.description || "");
  const [isSavingDesc, setIsSavingDesc] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditingDesc && descRef.current) {
      descRef.current.focus();
      const len = descValue.length;
      descRef.current.setSelectionRange(len, len);
    }
  }, [isEditingDesc]);

  useEffect(() => {
    if (!isEditingDesc) setDescValue(task.description || "");
  }, [task.description, isEditingDesc]);

  const handleSaveDesc = async () => {
    const trimmed = descValue.trim();
    if (trimmed === (task.description || "")) {
      setIsEditingDesc(false);
      return;
    }
    setIsSavingDesc(true);
    try {
      await handleSaveField("description", trimmed);
      setIsEditingDesc(false);
    } catch (err) {
      console.error("Error saving description:", err);
    } finally {
      setIsSavingDesc(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 bg-background">
      {/* Fecha de creación */}
      <div>
        <p className="text-xs text-muted-foreground">
          Creado: {formatDate(task._creationTime)}
        </p>
      </div>

      {/* Campos editables — Solo los que son nativos de COR o necesitan edición directa */}
      <div className="space-y-3">
        {/* Nombre de la task — editable para poder cambiar antes de publicar */}
        <EditableInfoItem
          icon="📝"
          label="Nombre"
          value={task.title || "Sin título"}
          fieldKey="title"
          editable={editable}
          onSave={handleSaveField}
        />

        {(task.deadline || editable) && (
          <EditableInfoItem
            icon="📅"
            label="Fecha de Fin"
            value={task.deadline || "No especificado"}
            fieldKey="deadline"
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.priority !== undefined || editable) && (
          <EditableSelectItem
            icon="⚡"
            label="Prioridad"
            value={String(task.priority ?? 1)}
            displayValue={`${PRIORITY_DISPLAY[task.priority ?? 1]?.icon || "→"} ${PRIORITY_DISPLAY[task.priority ?? 1]?.label || "Media"}`}
            fieldKey="priority"
            options={PRIORITY_OPTIONS}
            editable={editable}
            colorFn={getPriorityColor}
            onSave={handleSaveField}
          />
        )}

        {/* Estado — dropdown editable */}
        {(task.status || editable) && (
          <EditableSelectItem
            icon="🔄"
            label="Estado"
            value={task.status || "nueva"}
            displayValue={STATUS_DISPLAY[task.status] || task.status || "Nueva"}
            fieldKey="status"
            options={STATUS_OPTIONS}
            editable={editable}
            colorFn={getStatusColor}
            onSave={handleSaveField}
          />
        )}

        {/* Sync indicator — aparece tras guardar en una task publicada en COR */}
        {showingSyncFeedback && (
          <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 px-1 animate-in fade-in slide-in-from-top-1 duration-200">
            <Cloud className="h-3.5 w-3.5" />
            <span>Sincronizando cambios con COR...</span>
          </div>
        )}

        {/* Descripción completa — con edición inline */}
        {(task.description || editable) && (
          <div className="mt-4 pt-4 border-t border-border group/desc">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">
                Descripción completa
              </p>
              {editable && !isEditingDesc && (
                <button
                  onClick={() => setIsEditingDesc(true)}
                  className="opacity-0 group-hover/desc:opacity-100 p-1.5 rounded-md hover:bg-muted transition-all text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Editar descripción"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {isEditingDesc ? (
              <div>
                <textarea
                  ref={descRef}
                  value={descValue}
                  onChange={(e) => setDescValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSaveDesc();
                    }
                    if (e.key === "Escape") {
                      setDescValue(task.description || "");
                      setIsEditingDesc(false);
                    }
                  }}
                  rows={5}
                  className="w-full text-sm text-foreground bg-background border border-primary/40 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
                <div className="flex items-center gap-1.5 mt-1.5">
                  <button
                    onClick={handleSaveDesc}
                    disabled={isSavingDesc}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Check className="h-3 w-3" />
                    {isSavingDesc ? "Guardando..." : "Guardar"}
                  </button>
                  <button
                    onClick={() => {
                      setDescValue(task.description || "");
                      setIsEditingDesc(false);
                    }}
                    disabled={isSavingDesc}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground cursor-pointer"
                  >
                    <XIcon className="h-3 w-3" />
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {task.description || "No especificado"}
              </p>
            )}
          </div>
        )}

        {/* Archivos adjuntos */}
        {attachments && attachments.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
              📎 Archivos adjuntos ({attachments.length})
            </p>
            <div className="grid grid-cols-2 gap-2">
              {attachments.map((att) => (
                <button
                  key={att._id}
                  onClick={() => att.url && window.open(att.url, "_blank")}
                  className="bg-muted rounded-lg p-2 flex items-center gap-2 border border-border hover:bg-muted/80 transition-colors cursor-pointer"
                >
                  <span className="text-muted-foreground">
                    {att.mimeType.startsWith("image/") ? "🖼️" : "📄"}
                  </span>
                  <span className="text-xs text-foreground truncate">
                    {att.filename}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface EmptyTaskStateProps {
  onClose?: () => void;
}

/**
 * Estado vacío cuando no hay tarea
 */
export function EmptyTaskState({ onClose }: EmptyTaskStateProps) {
  return (
    <div className="h-full bg-card flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border bg-muted/50">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            📋 Tareas
          </h2>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              title="Cerrar panel"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Empty State */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-background">
        <div className="text-6xl mb-4">📝</div>
        <h3 className="text-lg font-medium text-foreground mb-2">
          Sin requerimiento aún
        </h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          El requerimiento aparecerá aquí una vez que completes la información
          con el asistente y confirmes que deseas guardarlo.
        </p>
      </div>
    </div>
  );
}

/**
 * Estado de carga del panel
 */
export function LoadingTaskState() {
  return (
    <div className="h-full bg-card flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Cargando...</div>
    </div>
  );
}
