"use client";

import type { Id } from "@/convex/_generated/dataModel";
import {
  formatDate,
  getStatusColor,
  getStatusDisplay,
  getPriorityConfig,
} from "../task/types";
import { clientConfig } from "@/config/tenant.config";

interface TaskCardTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;
  deadline?: string;
  priority?: number;
  status: string;
  corSyncStatus?: string;
  corTaskId?: string;
  corClientName?: string;
  corTaskMissingInCOR?: boolean;
  corProjectMissingInCOR?: boolean;
  trelloCardId?: string;
  trelloCardUrl?: string;
  trelloSyncStatus?: string;
}

interface TaskCardProps {
  task: TaskCardTask;
  onClick: () => void;
}

/**
 * Card que muestra un resumen de una task en el Panel de Control.
 * Clickeable → abre TaskDetailDialog.
 */
export function TaskCard({ task, onClick }: TaskCardProps) {
  const priorityConfig = getPriorityConfig(task.priority);
  const formattedDeadline = formatDeadline(task.deadline);
  const descriptionPreview = task.description
    ?.replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Determinar badge de sincronización
  const getSyncBadge = () => {
    if (task.corTaskMissingInCOR || task.corProjectMissingInCOR) {
      const tooltip =
        task.corTaskMissingInCOR && task.corProjectMissingInCOR
          ? "La task y su proyecto asociados no fueron encontrados en COR."
          : task.corTaskMissingInCOR
            ? "La task no fue encontrada en COR."
            : "El proyecto asociado no fue encontrado en COR.";

      return {
        label: "No encontrada en COR",
        className:
          "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400",
        icon: "⚠️",
        tooltip,
      };
    }

    switch (task.corSyncStatus) {
      case "synced":
        return {
          label: `Creada en ${clientConfig.ui.externalToolName}`,
          className:
            "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
          icon: "✅",
          tooltip: undefined,
        };
      case "syncing":
        return {
          label: "Sincronizando...",
          className:
            "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
          icon: "⏳",
          tooltip: undefined,
        };
      case "error":
        return {
          label: "Error de sincronización",
          className:
            "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400",
          icon: "❌",
          tooltip: undefined,
        };
      default:
        return {
          label: "Pendiente",
          className:
            "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
          icon: "🟡",
          tooltip: undefined,
        };
    }
  };

  const syncBadge = getSyncBadge();
  const isPublishedInTrello =
    task.trelloSyncStatus === "synced" ||
    Boolean(task.trelloCardId || task.trelloCardUrl);

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-xl p-4 hover:shadow-md hover:border-primary/30 transition-all duration-200 group cursor-pointer"
    >
      {/* Header: Title + Priority */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-2">
          {task.title}
        </h3>
        {priorityConfig && (
          <span className={`text-xs flex-shrink-0 ${priorityConfig.color}`}>
            {priorityConfig.icon}
          </span>
        )}
      </div>

      {/* Info: Description excerpt */}
      <div className="space-y-1 mb-3">
        {descriptionPreview && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {descriptionPreview}
          </p>
        )}
        {formattedDeadline && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Fecha:</span> {formattedDeadline}
          </p>
        )}
      </div>

      {/* Footer: Status + Sync badge */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${getStatusColor(task.status)}`}
        >
          {getStatusDisplay(task.status)}
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${syncBadge.className}`}
            title={syncBadge.tooltip}
          >
            {syncBadge.icon} {syncBadge.label}
          </span>
          {isPublishedInTrello && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
              ✅ En Trello
            </span>
          )}
        </div>
      </div>

      {/* Date */}
      <p className="text-xs text-muted-foreground mt-2">
        {formatDate(task._creationTime)}
      </p>
    </button>
  );
}

function formatDeadline(deadline?: string) {
  if (!deadline) return null;
  const normalized = deadline.slice(0, 10);
  const [year, month, day] = normalized.split("-");
  if (!year || !month || !day) return deadline;
  return `${day}/${month}/${year}`;
}
