"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDate, getStatusColor, getPriorityConfig } from "../task/types";
import { clientConfig } from "@/config/tenant.config";

interface TaskCardTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  brand: string;
  requestType: string;
  deadline?: string;
  priority?: string;
  status: string;
  corSyncStatus?: string;
  corTaskId?: string;
  corClientName?: string;
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

  // Determinar badge de sincronización
  const getSyncBadge = () => {
    switch (task.corSyncStatus) {
      case "synced":
        return {
          label: `Creada en ${clientConfig.ui.externalToolName}`,
          className:
            "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
          icon: "✅",
        };
      case "syncing":
        return {
          label: "Sincronizando...",
          className:
            "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
          icon: "⏳",
        };
      case "error":
        return {
          label: "Error de sincronización",
          className:
            "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400",
          icon: "❌",
        };
      default:
        return {
          label: "Pendiente",
          className:
            "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
          icon: "🟡",
        };
    }
  };

  const syncBadge = getSyncBadge();

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

      {/* Info: Brand + Type */}
      <div className="space-y-1 mb-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">🏢</span> {task.brand}
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">🏷️</span> {task.requestType}
        </p>
        {task.deadline && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">📅</span> {task.deadline}
          </p>
        )}
      </div>

      {/* Footer: Status + Sync badge */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${getStatusColor(task.status)}`}
        >
          {task.status}
        </span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${syncBadge.className}`}
        >
          {syncBadge.icon} {syncBadge.label}
        </span>
      </div>

      {/* Date */}
      <p className="text-xs text-muted-foreground mt-2">
        {formatDate(task._creationTime)}
      </p>
    </button>
  );
}
