"use client";

import { useState, useRef, useEffect } from "react";
import type { Task } from "./types";
import { formatDate } from "./types";
import { useConvex, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Pencil, Check, X as XIcon } from "lucide-react";
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
}

/**
 * Contenido del brief de una tarea.
 * Si editable=true, cada campo tiene un ícono de lápiz para editar en línea.
 */
export function TaskBriefContent({
  task,
  editable = false,
}: TaskBriefContentProps) {
  const convex = useConvex();
  const updateTask = useMutation(api.data.tasks.updateTaskFields);

  // Handler genérico para guardar un campo
  const handleSaveField = async (fieldKey: string, newValue: string) => {
    await updateTask({
      taskId: task._id,
      updates: { [fieldKey]: newValue },
    });
  };

  // Handler para abrir archivo
  const handleOpenFile = async (fileId: string) => {
    try {
      const url = await convex.query(api.data.files.getFileUrl, { fileId });
      if (url) {
        window.open(url, "_blank");
      } else {
        console.error("No se pudo obtener la URL del archivo");
        alert("No se pudo abrir el archivo");
      }
    } catch (error) {
      console.error("Error abriendo archivo:", error);
      alert("Error al abrir el archivo");
    }
  };

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
      {/* Título */}
      <div>
        <h3 className="text-xl font-bold text-foreground mb-1">{task.title}</h3>
        <p className="text-xs text-muted-foreground">
          Creado: {formatDate(task._creationTime)}
        </p>
      </div>

      {/* Info Grid */}
      <div className="space-y-3">
        <EditableInfoItem
          icon="🏷️"
          label="Tipo"
          value={task.requestType}
          fieldKey="requestType"
          editable={editable}
          onSave={handleSaveField}
        />
        <EditableInfoItem
          icon="🏢"
          label="Marca"
          value={task.brand}
          fieldKey="brand"
          editable={editable}
          onSave={handleSaveField}
        />
        {(task.objective || editable) && (
          <EditableInfoItem
            icon="🎯"
            label="Objetivo"
            value={task.objective || "No especificado"}
            fieldKey="objective"
            multiline
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.keyMessage || editable) && (
          <EditableInfoItem
            icon="💬"
            label="Mensaje clave"
            value={task.keyMessage || "No especificado"}
            fieldKey="keyMessage"
            multiline
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.kpis || editable) && (
          <EditableInfoItem
            icon="📊"
            label="KPIs"
            value={task.kpis || "No especificado"}
            fieldKey="kpis"
            multiline
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.deadline || editable) && (
          <EditableInfoItem
            icon="📅"
            label="Timing"
            value={task.deadline || "No especificado"}
            fieldKey="deadline"
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.budget || editable) && (
          <EditableInfoItem
            icon="💰"
            label="Presupuesto"
            value={task.budget || "No especificado"}
            fieldKey="budget"
            editable={editable}
            onSave={handleSaveField}
          />
        )}
        {(task.approvers || editable) && (
          <EditableInfoItem
            icon="👥"
            label="Aprobadores"
            value={task.approvers || "No especificado"}
            fieldKey="approvers"
            editable={editable}
            onSave={handleSaveField}
          />
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
        {task.fileIds && task.fileIds.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
              📎 Archivos adjuntos ({task.fileIds.length})
            </p>
            <div className="grid grid-cols-2 gap-2">
              {task.fileIds.map((fileId, index) => (
                <button
                  key={fileId}
                  onClick={() => handleOpenFile(fileId)}
                  className="bg-muted rounded-lg p-2 flex items-center gap-2 border border-border hover:bg-muted/80 transition-colors cursor-pointer"
                >
                  <span className="text-muted-foreground">📄</span>
                  <span className="text-xs text-foreground truncate">
                    Archivo {index + 1}
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
