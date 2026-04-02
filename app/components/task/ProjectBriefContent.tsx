"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Pencil, Check, X as XIcon, Cloud } from "lucide-react";
import type { Id, Doc } from "@/convex/_generated/dataModel";

// ==================== Tipos ====================

export type Project = Doc<"projects">;

// ==================== Subcomponentes inline ====================
// (Reusan el mismo patrón visual de TaskBriefContent)

interface EditableFieldProps {
  icon: string;
  label: string;
  value: string;
  fieldKey: string;
  multiline?: boolean;
  editable?: boolean;
  inputType?: "text" | "date" | "number";
  onSave?: (fieldKey: string, newValue: string) => Promise<void>;
}

function EditableField({
  icon,
  label,
  value,
  fieldKey,
  multiline = false,
  editable = false,
  inputType = "text",
  onSave,
}: EditableFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
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
                  type={inputType}
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
              {value || "No especificado"}
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

// ==================== SelectField ====================

interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
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

function SelectField({
  icon,
  label,
  value,
  displayValue,
  fieldKey,
  options,
  editable = false,
  colorFn,
  onSave,
}: SelectFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (isEditing && selectRef.current) selectRef.current.focus();
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setEditValue(value);
  }, [value, isEditing]);

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
                  if (e.key === "Escape") {
                    setEditValue(value);
                    setIsEditing(false);
                  }
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
                  onClick={() => {
                    setEditValue(value);
                    setIsEditing(false);
                  }}
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
            onClick={() => {
              setEditValue(value);
              setIsEditing(true);
            }}
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

// ==================== ProjectBriefContent ====================

interface ProjectBriefContentProps {
  project: Project;
  /** Si true, muestra íconos de edición en cada campo */
  editable?: boolean;
  /** Estado de sincronización del proyecto con COR */
  syncStatus?: string;
}

// Opciones de estado de proyecto
const PROJECT_STATUS_OPTIONS: SelectOption[] = [
  { value: "active", label: "Activo" },
  { value: "finished", label: "Finalizado" },
  { value: "suspended", label: "Suspendido" },
];

const PROJECT_STATUS_DISPLAY: Record<string, string> = {
  active: "Activo",
  finished: "Finalizado",
  suspended: "Suspendido",
};

const getProjectStatusColor = (value: string): string => {
  const colors: Record<string, string> = {
    active:
      "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    finished:
      "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    suspended:
      "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  };
  return colors[value] || colors.active;
};

/**
 * Contenido del brief de un proyecto.
 * Similar a TaskBriefContent pero para campos de proyecto.
 * Si editable=true, cada campo tiene un ícono de lápiz para editar en línea.
 */
export function ProjectBriefContent({
  project,
  editable = false,
  syncStatus,
}: ProjectBriefContentProps) {
  const updateProject = useMutation(api.data.projects.updateProjectFields);

  // Sync feedback indicator
  const [showingSyncFeedback, setShowingSyncFeedback] = useState(false);
  const syncFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSyncFeedback = () => {
    if (syncStatus !== "synced") return;
    setShowingSyncFeedback(true);
    if (syncFeedbackTimer.current) clearTimeout(syncFeedbackTimer.current);
    syncFeedbackTimer.current = setTimeout(() => {
      setShowingSyncFeedback(false);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (syncFeedbackTimer.current) clearTimeout(syncFeedbackTimer.current);
    };
  }, []);

  // Handler genérico para guardar un campo del proyecto
  const handleSaveField = async (fieldKey: string, newValue: string) => {
    if (fieldKey === "estimatedTime") {
      const numValue = parseFloat(newValue);
      await updateProject({
        projectId: project._id,
        estimatedTime: isNaN(numValue) ? undefined : numValue,
      });
      showSyncFeedback();
      return;
    }

    if (fieldKey === "status") {
      await updateProject({
        projectId: project._id,
        status: newValue,
      });
      showSyncFeedback();
      return;
    }

    await updateProject({
      projectId: project._id,
      [fieldKey]: newValue,
    });
    showSyncFeedback();
  };

  return (
    <div className="space-y-3">
      {/* Header de sección */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-base">📁</span>
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
          Proyecto
        </h3>
      </div>

      {/* Nombre del proyecto */}
      <EditableField
        icon="📝"
        label="Nombre del Proyecto"
        value={project.name || ""}
        fieldKey="name"
        editable={editable}
        onSave={handleSaveField}
      />

      {/* Brief / Descripción */}
      {(project.brief || editable) && (
        <EditableField
          icon="📄"
          label="Brief"
          value={project.brief || ""}
          fieldKey="brief"
          multiline
          editable={editable}
          onSave={handleSaveField}
        />
      )}

      {/* Fecha inicio */}
      {(project.startDate || editable) && (
        <EditableField
          icon="📅"
          label="Fecha Inicio"
          value={project.startDate || ""}
          fieldKey="startDate"
          inputType="date"
          editable={editable}
          onSave={handleSaveField}
        />
      )}

      {/* Fecha fin */}
      {(project.endDate || editable) && (
        <EditableField
          icon="🏁"
          label="Fecha Fin"
          value={project.endDate || ""}
          fieldKey="endDate"
          inputType="date"
          editable={editable}
          onSave={handleSaveField}
        />
      )}

      {/* Estado */}
      <SelectField
        icon="🔄"
        label="Estado"
        value={project.status || "active"}
        displayValue={
          PROJECT_STATUS_DISPLAY[project.status] || project.status || "Activo"
        }
        fieldKey="status"
        options={PROJECT_STATUS_OPTIONS}
        editable={editable}
        colorFn={getProjectStatusColor}
        onSave={handleSaveField}
      />

      {/* Horas estimadas */}
      {(project.estimatedTime !== undefined || editable) && (
        <EditableField
          icon="⏱"
          label="Horas Estimadas"
          value={
            project.estimatedTime !== undefined
              ? String(project.estimatedTime)
              : ""
          }
          fieldKey="estimatedTime"
          inputType="number"
          editable={editable}
          onSave={handleSaveField}
        />
      )}

      {/* Entregables */}
      {(project.deliverables || editable) && (
        <EditableField
          icon="📦"
          label="Entregables"
          value={project.deliverables || ""}
          fieldKey="deliverables"
          multiline
          editable={editable}
          onSave={handleSaveField}
        />
      )}

      {/* Sync feedback */}
      {showingSyncFeedback && (
        <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 px-1 animate-in fade-in slide-in-from-top-1 duration-200">
          <Cloud className="h-3.5 w-3.5" />
          <span>Sincronizando cambios del proyecto con COR...</span>
        </div>
      )}
    </div>
  );
}
