"use client";

import type { Id } from "@/convex/_generated/dataModel";
import {
  formatDate,
  getStatusColor,
  getStatusDisplay,
  getPriorityConfig,
} from "../task/types";
import { clientConfig } from "@/config/tenant.config";
import { ArrowRight, CalendarDays } from "lucide-react";

interface TaskCardTask {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  description?: string;
  deadline?: string;
  priority?: number;
  status: string;
  source?: "internal" | "external";
  createdByName?: string;
  createdByEmail?: string;
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
  const descriptionPreview = task.description
    ?.replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/Tipo de requerimiento\s*:/gi, "Tipo:")
    .replace(/\s+/g, " ")
    .trim();
  const creatorName = getCreatorDisplayName(task);
  const creatorInitials = getInitials(creatorName);
  const sourceLabel = task.source === "external" ? "Externo" : "Interno";
  const sourceBadgeClass =
    task.source === "external"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";

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
          label: "Pendiente en COR",
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
      className="group flex h-full w-full cursor-pointer flex-col rounded-xl border border-border bg-card p-3.5 text-left shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md"
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${getStatusColor(task.status)}`}
        >
          {getStatusDisplay(task.status)}
        </span>
        <ArrowRight className="h-4 w-4 flex-shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="mb-2">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-primary">
          {task.title}
        </h3>
      </div>

      <div className="mb-2.5 min-h-[2rem]">
        {descriptionPreview && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {descriptionPreview}
          </p>
        )}
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${syncBadge.className}`}
          title={syncBadge.tooltip}
        >
          {syncBadge.icon} {syncBadge.label}
        </span>
        {isPublishedInTrello && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            ✅ En Trello
          </span>
        )}
      </div>

      {priorityConfig && (
        <div className="mb-2.5">
          <span
            className={`inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium ${priorityConfig.color}`}
            title={priorityConfig.label}
          >
            {priorityConfig.icon} {priorityConfig.label}
          </span>
        </div>
      )}

      <div className="mt-auto space-y-2 text-xs text-muted-foreground">
        <span className="flex w-full min-w-0 items-center gap-1.5 pr-1 text-[10px] font-medium leading-4">
          <CalendarDays className="h-3 w-3 flex-shrink-0" />
          <span className="whitespace-nowrap">
            {formatDate(task._creationTime)}
          </span>
        </span>

        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 flex-1 items-center gap-2">
            <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-primary text-[11px] font-semibold text-primary">
              {creatorInitials}
            </span>
            <span className="min-w-0 truncate font-medium text-foreground">
              {creatorName}
            </span>
          </span>
          <span
            className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${sourceBadgeClass}`}
          >
            {sourceLabel}
          </span>
        </div>
      </div>
    </button>
  );
}

function getCreatorDisplayName(task: TaskCardTask) {
  return task.createdByName || task.createdByEmail || "Usuario";
}

function getInitials(value: string) {
  const parts = value
    .replace(/@.*/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
