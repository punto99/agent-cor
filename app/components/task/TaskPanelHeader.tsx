"use client";

import { getStatusDisplay } from "./types";

interface TaskPanelHeaderProps {
  title: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onClose?: () => void;
}

/**
 * Header del panel de tareas con botones de expandir/cerrar
 */
export function TaskPanelHeader({
  title,
  isExpanded,
  onToggleExpand,
  onClose,
}: TaskPanelHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
        {title}
      </h2>
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleExpand}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {isExpanded ? "▼" : "▶"}
        </button>
        {onClose && <CloseButton onClick={onClose} />}
      </div>
    </div>
  );
}

/**
 * Botón de cerrar reutilizable
 */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
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
  );
}

interface TabButtonProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
}

/**
 * Botón de tab para cambiar entre Brief y Evaluación
 */
export function TabButton({ label, isActive, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
        isActive
          ? "bg-card text-primary shadow-sm"
          : "text-muted-foreground hover:bg-card/50"
      }`}
    >
      {label}
    </button>
  );
}

interface StatusBadgeProps {
  status: string;
  colorClass: string;
}

/**
 * Badge de estado de la tarea
 */
export function StatusBadge({ status, colorClass }: StatusBadgeProps) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}
    >
      {getStatusDisplay(status)}
    </span>
  );
}

interface PriorityBadgeProps {
  priority?: number;
  config: { color: string; icon: string; label: string } | null;
}

/**
 * Badge de prioridad de la tarea
 */
export function PriorityBadge({ priority, config }: PriorityBadgeProps) {
  if (!config || priority === undefined || priority === null) return null;
  return (
    <span className={`${config.color} text-xs font-medium`}>
      {config.icon} {config.label}
    </span>
  );
}
