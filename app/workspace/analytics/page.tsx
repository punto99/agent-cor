"use client";

import { useEffect } from "react";
import type { ComponentType, ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FolderKanban,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";

export default function AnalyticsPage() {
  const router = useRouter();
  const analyticsAccess = useQuery(api.data.analytics.viewerCanAccessAnalytics);
  const analytics = useQuery(api.data.analytics.getDashboard);
  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    {},
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);

  useEffect(() => {
    if (analyticsAccess && !analyticsAccess.canAccess) {
      router.replace("/workspace");
    }
  }, [analyticsAccess, router]);

  const handleNewThread = async () => {
    await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    router.push("/workspace");
  };

  const handleSelectThread = () => {
    router.push("/workspace");
  };

  if (
    analyticsAccess === undefined ||
    analytics === undefined ||
    threadsStatus === "LoadingFirstPage" ||
    !analyticsAccess.canAccess ||
    !analytics.canAccess
  ) {
    return <LoadingScreen />;
  }

  const statusTotal = sumCounts(analytics.statusCounts);
  const priorityTotal = sumCounts(analytics.strategicPriorityCounts);
  const evaluationTotal = sumCounts(analytics.evaluations.statusCounts);

  return (
    <WorkspaceLayout
      threads={threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
      onNewThread={handleNewThread}
      onSelectThread={handleSelectThread}
    >
      <div className="h-full overflow-y-auto bg-background">
        <div className="p-6 space-y-6 max-w-7xl">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Analytics
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Vista operativa de proyectos, tasks, COR y evaluaciones.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricCard
              title="Tasks"
              value={analytics.summary.tasks}
              detail={`${analytics.summary.externalTasks} externas`}
              icon={ClipboardList}
            />
            <MetricCard
              title="Proyectos"
              value={analytics.summary.projects}
              detail="Creados recientemente"
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
              detail={`${analytics.evaluations.total} threads de evaluación`}
              icon={Sparkles}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <AnalyticsPanel title="Tasks Por Estado" className="xl:col-span-2">
              <BarList items={analytics.statusCounts} total={statusTotal} />
            </AnalyticsPanel>

            <AnalyticsPanel title="Origen De Tasks">
              <BarList
                items={analytics.sourceCounts}
                total={sumCounts(analytics.sourceCounts)}
              />
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <AnalyticsPanel title="Clientes Con Más Movimiento">
              <BarList
                items={analytics.tasksByClient.map((item) => ({
                  key: item.clientId,
                  label: item.name,
                  count: item.count,
                }))}
                total={analytics.summary.tasks}
              />
            </AnalyticsPanel>

            <AnalyticsPanel title="Marcas Con Más Movimiento">
              <BarList
                items={analytics.tasksByBrand.map((item) => ({
                  key: item.brandId,
                  label: item.name,
                  count: item.count,
                }))}
                total={analytics.summary.tasks}
              />
            </AnalyticsPanel>

            <AnalyticsPanel title="Prioridad Estratégica">
              <BarList
                items={analytics.strategicPriorityCounts}
                total={priorityTotal}
              />
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <AnalyticsPanel
              title="Tasks Por Usuario"
              icon={<Users className="h-4 w-4 text-primary" />}
            >
              <BarList
                items={analytics.tasksByUser.map((item) => ({
                  key: item.userId,
                  label: item.name,
                  count: item.count,
                }))}
                total={analytics.summary.tasks}
              />
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Evaluaciones Por Usuario"
              icon={<Sparkles className="h-4 w-4 text-primary" />}
            >
              <BarList
                items={analytics.evaluationsByUser.map((item) => ({
                  key: item.userId,
                  label: item.name,
                  count: item.count,
                }))}
                total={analytics.evaluations.total}
              />
              <p className="text-xs text-muted-foreground mt-3">
                Atribuido al usuario que creó la task evaluada.
              </p>
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <AnalyticsPanel title="Creación Semanal" className="xl:col-span-2">
              <TrendBars items={analytics.weeklyTrend} />
            </AnalyticsPanel>

            <AnalyticsPanel title="Evaluaciones">
              <BarList
                items={analytics.evaluations.statusCounts}
                total={evaluationTotal}
              />
              <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">
                  Tasks evaluadas
                </div>
                <div className="text-2xl font-semibold text-foreground">
                  {analytics.evaluations.evaluatedTasks}
                </div>
              </div>
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <AnalyticsPanel
              title="Vencidas"
              icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
            >
              <TaskList items={analytics.attention.overdue} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Próximas A Vencer"
              icon={<CalendarClock className="h-4 w-4 text-amber-500" />}
            >
              <TaskList items={analytics.attention.dueSoon} />
            </AnalyticsPanel>
          </div>

          <p className="text-xs text-muted-foreground">
            Métricas calculadas sobre las últimas{" "}
            {analytics.limits.taskSampleSize} tasks leídas y{" "}
            {analytics.limits.evaluationSampleSize} evaluaciones recientes.
          </p>
        </div>
      </div>
    </WorkspaceLayout>
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
            {value}
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

function AnalyticsPanel({
  title,
  children,
  className = "",
  icon,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-border bg-card p-4 ${className}`}
    >
      <div className="flex items-center gap-2 mb-4">
        {icon ?? <BarChart3 className="h-4 w-4 text-primary" />}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function BarList({
  items,
  total,
}: {
  items: Array<{ key: string; label: string; count: number }>;
  total: number;
}) {
  if (items.length === 0 || total === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const percentage = Math.round((item.count / total) * 100);
        return (
          <div key={item.key}>
            <div className="flex items-center justify-between gap-3 text-xs mb-1">
              <span className="text-foreground truncate">{item.label}</span>
              <span className="text-muted-foreground">{item.count}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(percentage, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrendBars({
  items,
}: {
  items: Array<{ week: string; count: number }>;
}) {
  const max = Math.max(...items.map((item) => item.count), 1);

  return (
    <div className="flex items-end gap-2 h-48">
      {items.map((item) => (
        <div
          key={item.week}
          className="flex-1 flex flex-col items-center gap-2"
        >
          <div className="w-full flex items-end justify-center h-36 rounded-md bg-muted/40">
            <div
              className="w-full max-w-10 rounded-t-md bg-primary"
              style={{ height: `${Math.max((item.count / max) * 100, 4)}%` }}
              title={`${item.count} tasks`}
            />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {formatShortDate(item.week)}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskList({
  items,
}: {
  items: Array<{
    _id: string;
    title: string;
    deadline?: string;
    status: string;
    source?: "internal" | "external";
  }>;
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        No hay tasks para mostrar.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <div key={item._id} className="py-2 first:pt-0 last:pb-0">
          <div className="text-sm font-medium text-foreground truncate">
            {item.title}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {item.deadline ? formatDate(item.deadline) : "Sin fecha"} ·{" "}
            {item.status} · {item.source === "external" ? "Externa" : "Interna"}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return <div className="text-sm text-muted-foreground">Sin datos.</div>;
}

function sumCounts(items: Array<{ count: number }>) {
  return items.reduce((sum, item) => sum + item.count, 0);
}

function formatDate(value: string) {
  const normalized = value.slice(0, 10);
  const [year, month, day] = normalized.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function formatShortDate(value: string) {
  const [, month, day] = value.split("-");
  if (!month || !day) return value;
  return `${day}/${month}`;
}
