"use client";

import { Suspense, useEffect, useId, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Bar } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FolderKanban,
  PackageCheck,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  addAnalyticsDays,
  analyticsDay,
  analyticsFirstDay,
  analyticsPeriod,
  analyticsPeriodTypes,
  isAnalyticsDay,
  shiftAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsPeriodType,
} from "@/convex/analytics/calendar";
import { LoadingScreen } from "../../components/LoadingScreen";
import { WorkspaceLayout } from "../../components/WorkspaceLayout";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AnalyticsDashboard />
    </Suspense>
  );
}

function AnalyticsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [today, setToday] = useState(() => analyticsDay(Date.now()));
  const periodType =
    analyticsPeriodTypes.find((type) => type === searchParams.get("period")) ??
    "all";
  const date = searchParams.get("date");
  const selectedDay =
    date && isAnalyticsDay(date) && date <= today ? date : today;
  const anchor =
    selectedDay < analyticsFirstDay ? analyticsFirstDay : selectedDay;
  const period = analyticsPeriod(periodType, anchor);
  const analyticsAccess = useQuery(api.data.analytics.viewerCanAccessAnalytics);
  const viewerId = analyticsAccess?.canAccess
    ? analyticsAccess.userId
    : undefined;
  const periodAnalytics = useQuery(
    api.data.analytics.getPeriodDashboard,
    analyticsAccess?.canAccess ? { ...period, today } : "skip",
  );
  const loadingBackfill =
    periodAnalytics?.canAccess === true && !periodAnalytics.ready;
  const legacyAnalytics = useQuery(
    api.data.analytics.getDashboard,
    loadingBackfill ? {} : "skip",
  );
  const currentAnalytics =
    periodAnalytics?.canAccess && periodAnalytics.ready
      ? periodAnalytics
      : undefined;
  const [lastPeriod, setLastPeriod] = useState<{
    analytics: NonNullable<typeof currentAnalytics>;
    periodType: AnalyticsPeriodType;
    viewerId: string;
  }>();
  const previousPeriod =
    periodAnalytics === undefined &&
    viewerId &&
    lastPeriod?.viewerId === viewerId
      ? lastPeriod
      : undefined;
  const analytics =
    currentAnalytics ?? previousPeriod?.analytics ?? legacyAnalytics;
  const displayedPeriodType = previousPeriod?.periodType ?? periodType;
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
    if (currentAnalytics && viewerId) {
      setLastPeriod({ analytics: currentAnalytics, periodType, viewerId });
    }
  }, [currentAnalytics, periodType, viewerId]);

  useEffect(() => {
    const refreshDay = () => setToday(analyticsDay(Date.now()));
    const timer = window.setInterval(refreshDay, 30_000);
    window.addEventListener("focus", refreshDay);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshDay);
    };
  }, []);

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

  function selectPeriod(type: AnalyticsPeriodType, day: string) {
    if (!isAnalyticsDay(day) || day < analyticsFirstDay || day > today) return;
    const url = new URL(window.location.href);
    if (type === "all") {
      url.searchParams.delete("period");
      url.searchParams.delete("date");
    } else {
      url.searchParams.set("period", type);
      url.searchParams.set("date", day);
    }
    window.history.replaceState(null, "", url);
  }

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
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 grow basis-64">
              <h1 className="text-2xl font-semibold text-foreground">
                Analíticas
              </h1>
              <p
                className="mt-1 truncate text-sm text-muted-foreground"
                role="status"
              >
                {previousPeriod
                  ? "Actualizando periodo…"
                  : "Vista operativa de proyectos, tasks, COR y evaluaciones."}
              </p>
            </div>
            <AnalyticsPeriodPicker
              period={loadingBackfill ? analyticsPeriod("all", today) : period}
              anchor={anchor}
              today={today}
              disabled={loadingBackfill}
              onSelect={selectPeriod}
            />
          </div>
          {loadingBackfill && (
            <p
              id="analytics-period-status"
              className="text-xs text-muted-foreground"
            >
              Estás viendo Histórico. La carga inicial de analíticas habilitará
              los demás periodos.
            </p>
          )}

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
            <AnalyticsPanel
              title="Entregables Por Cliente"
              className="xl:col-span-2"
              icon={<PackageCheck className="h-4 w-4 text-primary" />}
            >
              <DeliverablesBreakdown
                items={analytics.deliverables.byClient.slice(0, 8)}
                total={analytics.deliverables.historicalTotal}
              />
            </AnalyticsPanel>

            <AnalyticsPanel title="Prioridad Estratégica">
              <BarList
                items={analytics.strategicPriorityCounts}
                total={priorityTotal}
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
                scale="max"
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
                scale="max"
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
                scale="max"
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
                scale="max"
              />
              <p className="text-xs text-muted-foreground mt-3">
                Atribuido al usuario que solicitó la evaluación.
              </p>
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <AnalyticsPanel
              title={
                loadingBackfill || displayedPeriodType === "all"
                  ? "Creación Semanal de tareas"
                  : displayedPeriodType === "year"
                    ? "Creación Mensual de tareas"
                    : "Creación Diaria de tareas"
              }
              className="xl:col-span-2"
            >
              <TrendBars
                items={analytics.weeklyTrend}
                formatLabel={
                  !loadingBackfill && displayedPeriodType === "year"
                    ? formatShortMonth
                    : formatShortDate
                }
              />
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
            {"limits" in analytics
              ? `Métricas calculadas sobre ${analytics.limits.taskSampleSize} tasks y ${analytics.limits.evaluationSampleSize} evaluaciones recientes.`
              : "Periodos por fecha de creación."}
          </p>
        </div>
      </div>
    </WorkspaceLayout>
  );
}

const periodLabels: Record<AnalyticsPeriodType, string> = {
  day: "Día",
  week: "Semana",
  month: "Mes",
  year: "Año",
  all: "Histórico",
};

const shortPeriodDate = new Intl.DateTimeFormat("es-EC", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const longPeriodMonth = new Intl.DateTimeFormat("es-EC", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function AnalyticsPeriodPicker({
  period,
  anchor,
  today,
  disabled,
  onSelect,
}: {
  period: AnalyticsPeriod;
  anchor: string;
  today: string;
  disabled: boolean;
  onSelect: (type: AnalyticsPeriodType, day: string) => void;
}) {
  const { periodType, periodKey } = period;
  const canNavigate = !disabled && periodType !== "all";
  const previous = shiftAnalyticsPeriod(period, -1);
  const next = shiftAnalyticsPeriod(period, 1);
  const firstPeriodKey = analyticsPeriod(
    periodType,
    analyticsFirstDay,
  ).periodKey;
  const visibleStart =
    periodKey < analyticsFirstDay ? analyticsFirstDay : periodKey;
  const firstDay = new Date(`${visibleStart}T00:00:00Z`);
  const dateLabel =
    periodType === "all"
      ? "Todos los periodos"
      : periodType === "year"
        ? periodKey.slice(0, 4)
        : periodType === "month"
          ? longPeriodMonth.format(firstDay)
          : periodType === "week"
            ? `${shortPeriodDate.format(firstDay)} – ${shortPeriodDate.format(
                new Date(`${addAnalyticsDays(periodKey, 6)}T00:00:00Z`),
              )}`
            : shortPeriodDate.format(firstDay);

  return (
    <div
      aria-label="Periodo de analíticas"
      aria-describedby={disabled ? "analytics-period-status" : undefined}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2"
      role="group"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        {analyticsPeriodTypes.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={periodType === type}
            disabled={disabled && type !== "all"}
            onClick={() => onSelect(type, anchor)}
            className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              periodType === type
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground enabled:hover:text-foreground"
            }`}
          >
            {periodLabels[type]}
          </button>
        ))}
      </div>
      <div className="grid w-80 max-w-full grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2">
        <button
          type="button"
          aria-label="Periodo anterior"
          disabled={!canNavigate || previous < firstPeriodKey}
          onClick={() =>
            onSelect(
              periodType,
              previous < analyticsFirstDay ? analyticsFirstDay : previous,
            )
          }
          className="grid size-8 place-items-center rounded-lg bg-muted text-foreground disabled:opacity-40"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
        <div className="relative flex h-8 min-w-0 items-center justify-center rounded-lg border border-border px-3 text-sm text-foreground focus-within:ring-2 focus-within:ring-primary">
          <span className="truncate" aria-hidden={canNavigate}>
            {dateLabel}
          </span>
          {canNavigate && (
            <input
              type="date"
              aria-label="Elegir fecha del periodo"
              value={anchor}
              min={analyticsFirstDay}
              max={today}
              onChange={(event) => onSelect(periodType, event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full"
            />
          )}
        </div>
        <button
          type="button"
          aria-label="Periodo siguiente"
          disabled={!canNavigate || !isAnalyticsDay(next) || next > today}
          onClick={() => onSelect(periodType, next)}
          className="grid size-8 place-items-center rounded-lg bg-muted text-foreground disabled:opacity-40"
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
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
  scale = "total",
}: {
  items: Array<{ key: string; label: string; count: number }>;
  total: number;
  scale?: "total" | "max";
}) {
  const scaleMaximum =
    scale === "max" ? Math.max(...items.map((item) => item.count), 0) : total;

  if (items.length === 0 || scaleMaximum <= 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const percentage = Math.min((item.count / scaleMaximum) * 100, 100);
        const width = item.count > 0 ? Math.max(percentage, 2) : 0;
        return (
          <div key={item.key}>
            <div className="flex items-center justify-between gap-3 text-xs mb-1">
              <span className="text-foreground truncate">{item.label}</span>
              <span className="text-muted-foreground">{item.count}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeliverablesBreakdown({
  items,
  total,
}: {
  items: Array<{
    clientId: string;
    name: string;
    deliverablesTotal: number;
    projectCount: number;
    brands: Array<{
      clientBrandId: string;
      name: string;
      deliverablesTotal: number;
      projectCount: number;
      subBrands: Array<{
        subBrandId: string;
        name: string;
        deliverablesTotal: number;
        projectCount: number;
      }>;
    }>;
  }>;
  total: number;
}) {
  if (items.length === 0 || total === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-4">
      {items.map((client) => {
        const percentage = Math.round((client.deliverablesTotal / total) * 100);
        return (
          <div key={client.clientId} className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground font-medium truncate">
                {client.name}
              </span>
              <span className="text-muted-foreground whitespace-nowrap">
                {formatNumber(client.deliverablesTotal)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(percentage, 2)}%` }}
              />
            </div>
            {client.brands.length > 0 && (
              <div className="rounded-md border border-border bg-muted/25 divide-y divide-border">
                {client.brands.slice(0, 4).map((brand) => (
                  <div
                    key={brand.clientBrandId}
                    className="px-3 py-2 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-foreground truncate">
                        {brand.name}
                      </span>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {formatNumber(brand.deliverablesTotal)}
                      </span>
                    </div>
                    {brand.subBrands.length > 0 && (
                      <div className="text-muted-foreground truncate">
                        {brand.subBrands
                          .slice(0, 3)
                          .map(
                            (subBrand) =>
                              `${subBrand.name}: ${formatNumber(subBrand.deliverablesTotal)}`,
                          )
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type TaskTrendPoint = {
  week: string;
  count: number;
  internal: number;
  external: number;
};

const trendSources = [
  { key: "internal", label: "Internas", color: "hsl(var(--primary))" },
  { key: "external", label: "Clientes externos", color: "hsl(36 92% 46%)" },
] as const;

function TrendBars({
  formatLabel,
  items,
}: {
  formatLabel: (value: string) => string;
  items: TaskTrendPoint[];
}) {
  const {
    tooltipData,
    tooltipLeft = 0,
    tooltipOpen,
    tooltipTop = 0,
    showTooltip,
    hideTooltip,
  } = useTooltip<TaskTrendPoint>();

  return (
    <>
      <div className="relative h-56">
        <ParentSize>
          {({ width }) =>
            width > 0 ? (
              <WeeklyTrendChart
                formatLabel={formatLabel}
                height={224}
                items={items}
                width={width}
                onTooltip={({ datum, left, top }) =>
                  showTooltip({
                    tooltipData: datum,
                    tooltipLeft: left,
                    tooltipTop: top,
                  })
                }
                onTooltipHide={hideTooltip}
              />
            ) : null
          }
        </ParentSize>

        {tooltipOpen && tooltipData && (
          <TooltipWithBounds
            left={tooltipLeft}
            top={tooltipTop}
            className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          >
            <div className="font-medium">{formatLabel(tooltipData.week)}</div>
            {trendSources.map(({ key, label }) => (
              <div key={key} className="text-muted-foreground">
                {label}: {formatNumber(tooltipData[key])}
              </div>
            ))}
            <div className="mt-1 font-medium">
              Total: {formatNumber(tooltipData.count)}
            </div>
          </TooltipWithBounds>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {trendSources.map(({ key, label, color }) => (
          <li key={key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {label}
          </li>
        ))}
      </ul>
    </>
  );
}

function WeeklyTrendChart({
  formatLabel,
  height,
  items,
  onTooltip,
  onTooltipHide,
  width,
}: {
  formatLabel: (value: string) => string;
  height: number;
  items: TaskTrendPoint[];
  onTooltip: (args: {
    datum: TaskTrendPoint;
    left: number;
    top: number;
  }) => void;
  onTooltipHide: () => void;
  width: number;
}) {
  const clipPrefix = useId();
  const margin = { top: 12, right: 12, bottom: 32, left: 42 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);
  const maxCount = Math.max(...items.map((item) => item.count), 1);
  const yTicks = buildIntegerTicks(maxCount);
  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: items.map((item) => item.week),
        padding: 0.28,
        range: [0, innerWidth],
      }),
    [innerWidth, items],
  );
  const yScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, maxCount],
        nice: true,
        range: [innerHeight, 0],
      }),
    [innerHeight, maxCount],
  );

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <svg height={height} width={width}>
      <Group left={margin.left} top={margin.top}>
        {yTicks.map((tick) => (
          <line
            key={tick}
            x1={0}
            x2={innerWidth}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke="hsl(var(--border))"
            strokeDasharray="3 4"
            strokeOpacity={0.75}
          />
        ))}

        <AxisLeft
          hideAxisLine
          hideTicks
          scale={yScale}
          tickFormat={(value) => String(value)}
          tickValues={yTicks}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            textAnchor: "end",
            dy: "0.32em",
            dx: "-0.35em",
          })}
        />

        <AxisBottom
          hideAxisLine
          hideTicks
          scale={xScale}
          top={innerHeight}
          tickFormat={formatLabel}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            textAnchor: "middle",
            dy: "0.7em",
          })}
        />

        {items.map((item) => {
          const barX = xScale(item.week) ?? 0;
          const barY = yScale(item.count);
          const barWidth = xScale.bandwidth();
          const barHeight = innerHeight - barY;
          const visibleHeight = item.count > 0 ? Math.max(barHeight, 3) : 0;
          const barTop = innerHeight - visibleHeight;
          const internalHeight =
            item.count > 0 ? visibleHeight * (item.internal / item.count) : 0;
          const externalHeight = visibleHeight - internalHeight;
          const clipId = `${clipPrefix}-${item.week}`;
          const showBarTooltip = () =>
            onTooltip({
              datum: item,
              left: margin.left + barX + barWidth / 2,
              top: margin.top + Math.max(barY - 8, 0),
            });

          return (
            <g
              key={item.week}
              tabIndex={0}
              role="img"
              aria-label={`${formatLabel(item.week)}: ${item.internal} internas, ${item.external} externas, ${item.count} en total`}
              onBlur={onTooltipHide}
              onFocus={showBarTooltip}
              onMouseLeave={onTooltipHide}
              onMouseMove={showBarTooltip}
            >
              <clipPath id={clipId}>
                <rect
                  x={barX}
                  y={barTop}
                  width={barWidth}
                  height={visibleHeight}
                  rx={6}
                />
              </clipPath>
              <g clipPath={`url(#${clipId})`}>
                <Bar
                  x={barX}
                  y={barTop}
                  width={barWidth}
                  height={externalHeight}
                  fill={trendSources[1].color}
                />
                <Bar
                  x={barX}
                  y={innerHeight - internalHeight}
                  width={barWidth}
                  height={internalHeight}
                  fill={trendSources[0].color}
                />
              </g>
            </g>
          );
        })}
      </Group>
    </svg>
  );
}

function buildIntegerTicks(maxValue: number) {
  if (maxValue <= 1) return [0, 1];
  if (maxValue <= 4) {
    return Array.from({ length: maxValue + 1 }, (_, index) => index);
  }

  const step = Math.ceil(maxValue / 4);
  const ticks = new Set<number>([0, maxValue]);
  for (let value = step; value < maxValue; value += step) {
    ticks.add(value);
  }
  return Array.from(ticks).sort((a, b) => a - b);
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

function formatNumber(value: number) {
  return new Intl.NumberFormat("es").format(value);
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

const shortMonthLabels = [
  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic",
];

function formatShortMonth(value: string) {
  return (
    shortMonthLabels[Number(value.slice(5, 7)) - 1] ?? formatShortDate(value)
  );
}
