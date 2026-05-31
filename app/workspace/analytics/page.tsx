"use client";

import { useEffect, useMemo } from "react";
import type { ComponentType, ReactNode } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Bar } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FolderKanban,
  PackageCheck,
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
            <MetricCard
              title="Entregables"
              value={analytics.summary.deliverables}
              detail={`${analytics.deliverables.projectCount} proyectos históricos`}
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

function TrendBars({
  items,
}: {
  items: Array<{ week: string; count: number }>;
}) {
  const {
    tooltipData,
    tooltipLeft = 0,
    tooltipOpen,
    tooltipTop = 0,
    showTooltip,
    hideTooltip,
  } = useTooltip<{ week: string; count: number }>();

  return (
    <div className="relative h-56">
      <ParentSize>
        {({ width }) =>
          width > 0 ? (
            <WeeklyTrendChart
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
          <div className="font-medium">{formatShortDate(tooltipData.week)}</div>
          <div className="text-muted-foreground">
            {tooltipData.count} task{tooltipData.count !== 1 ? "s" : ""}
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}

function WeeklyTrendChart({
  height,
  items,
  onTooltip,
  onTooltipHide,
  width,
}: {
  height: number;
  items: Array<{ week: string; count: number }>;
  onTooltip: (args: {
    datum: { week: string; count: number };
    left: number;
    top: number;
  }) => void;
  onTooltipHide: () => void;
  width: number;
}) {
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
          tickFormat={(value) => formatShortDate(String(value))}
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
          const minVisibleHeight = item.count > 0 ? Math.max(barHeight, 3) : 0;

          return (
            <Bar
              key={item.week}
              x={barX}
              y={item.count > 0 ? innerHeight - minVisibleHeight : innerHeight}
              width={barWidth}
              height={minVisibleHeight}
              rx={6}
              fill="hsl(var(--primary))"
              tabIndex={0}
              role="img"
              aria-label={`${formatShortDate(item.week)}: ${item.count} tasks`}
              onBlur={onTooltipHide}
              onFocus={() =>
                onTooltip({
                  datum: item,
                  left: margin.left + barX + barWidth / 2,
                  top: margin.top + Math.max(barY - 8, 0),
                })
              }
              onMouseLeave={onTooltipHide}
              onMouseMove={() =>
                onTooltip({
                  datum: item,
                  left: margin.left + barX + barWidth / 2,
                  top: margin.top + Math.max(barY - 8, 0),
                })
              }
            />
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
