import type { ComponentType } from "react";
import {
  ClipboardList,
  FolderKanban,
  PackageCheck,
  Send,
  Sparkles,
} from "lucide-react";
import type { AnalyticsData } from "./types";
import { formatNumber } from "./utils";

export function AnalyticsSummary({
  analytics,
  loadingBackfill,
}: {
  analytics: AnalyticsData;
  loadingBackfill: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
      <MetricCard
        title="Tasks"
        value={analytics.summary.tasks}
        detail={`${analytics.summary.externalTasks} externas`}
        icon={ClipboardList}
      />
      <MetricCard
        title="Proyectos"
        value={analytics.summary.projects}
        detail={
          loadingBackfill
            ? "Creados recientemente"
            : "Creados en el periodo"
        }
        icon={FolderKanban}
      />
      <MetricCard
        title="Pendientes COR"
        value={analytics.summary.pendingCorTasks}
        detail={`${analytics.summary.errorCorTasks} con error`}
        icon={Send}
      />
      <MetricCard
        title="Evaluadas"
        value={analytics.summary.evaluatedTasks}
        detail={`${analytics.evaluations.total} registros de evaluación`}
        icon={Sparkles}
      />
      <MetricCard
        title="Entregables"
        value={analytics.summary.deliverables}
        detail={`${analytics.deliverables.projectCount} proyectos con entregables`}
        icon={PackageCheck}
      />
    </div>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: number;
  detail: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-muted-foreground">{title}</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {formatNumber(value)}
          </div>
        </div>
        <div className="h-10 w-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="text-xs text-muted-foreground mt-3">{detail}</div>
    </div>
  );
}
