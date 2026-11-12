import {
  AlertTriangle,
  CalendarClock,
  PackageCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { AnalyticsPeriodType } from "@/convex/analytics/calendar";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { AnalyticsSummary } from "./AnalyticsSummary";
import { BarList } from "./BarList";
import { DeliverablesBreakdown } from "./DeliverablesBreakdown";
import { TaskCreationPanel } from "./TaskCreationPanel";
import { TaskList } from "./TaskList";
import type { AnalyticsData } from "./types";
import { sumCounts } from "./utils";

export function AnalyticsOverview({
  analytics,
  periodType,
  loadingBackfill,
  onSelectYear,
}: {
  analytics: AnalyticsData;
  periodType: AnalyticsPeriodType;
  loadingBackfill: boolean;
  onSelectYear: (yearStart: string) => void;
}) {
  const monthlyTrend = "monthlyTrend" in analytics ? analytics.monthlyTrend : null;
  const statusTotal = sumCounts(analytics.statusCounts);
  const priorityTotal = sumCounts(analytics.strategicPriorityCounts);
  const evaluationTotal = sumCounts(analytics.evaluations.statusCounts);

  return (
    <>
      <AnalyticsSummary
        analytics={analytics}
        loadingBackfill={loadingBackfill}
      />

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
        <TaskCreationPanel
          items={
            monthlyTrend ?? analytics.weeklyTrend.map(({ week, ...counts }) => ({
              periodKey: week,
              ...counts,
            }))
          }
          historical={monthlyTrend != null}
          periodType={periodType}
          loadingBackfill={loadingBackfill}
          onSelectYear={onSelectYear}
        />

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
    </>
  );
}
