import { useState } from "react";
import { ParentSize } from "@visx/responsive";
import { useTooltip } from "@visx/tooltip";
import { CalendarDays } from "lucide-react";
import { analyticsPeriod, type AnalyticsPeriodType } from "@/convex/analytics/calendar";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { TaskCreationChart, trendSources } from "./TaskCreationChart";
import type { TaskTrendPoint } from "./types";
import {
  formatMonthYear,
  formatNumber,
  formatShortDate,
  formatShortMonth,
  formatWeekRange,
} from "./utils";

const trendTooltipWidth = 172;

export function TaskCreationPanel({
  items,
  historical,
  periodType,
  loadingBackfill,
  onSelectYear,
}: {
  items: TaskTrendPoint[];
  historical: boolean;
  periodType: AnalyticsPeriodType;
  loadingBackfill: boolean;
  onSelectYear: (yearStart: string) => void;
}) {
  const [groupBy, setGroupBy] = useState<"month" | "year">("month");
  const firstMonth = items[0]?.periodKey;
  const lastMonth = items.at(-1)?.periodKey;
  const multipleYears =
    historical && firstMonth?.slice(0, 4) !== lastMonth?.slice(0, 4);
  const annual = multipleYears && groupBy === "year";
  const trend = annual ? groupTrendByYear(items) : items;
  const showWeekRanges = !historical && !loadingBackfill && periodType === "all";
  const monthlyLabels = historical || (!loadingBackfill && periodType === "year");
  function formatLabel(key: string) {
    if (annual) return key.slice(0, 4);
    if (multipleYears) return `${formatShortMonth(key)} ${key.slice(0, 4)}`;
    return monthlyLabels ? formatShortMonth(key) : formatShortDate(key);
  }

  const formatDetailLabel = historical && !annual ? formatMonthYear : formatLabel;
  const title = historical
    ? `Tareas creadas por ${annual ? "año" : "mes"}`
    : loadingBackfill || periodType === "all"
      ? "Tareas creadas por semana"
      : periodType === "year"
        ? "Creación Mensual de tareas"
        : "Creación Diaria de tareas";
  const totalLabel = historical
    ? annual ? "Total anual" : "Total mensual"
    : showWeekRanges ? "Total semanal" : "Total";
  const {
    tooltipData,
    tooltipLeft = 0,
    tooltipOpen,
    tooltipTop = 0,
    showTooltip,
    hideTooltip,
  } = useTooltip<TaskTrendPoint>();

  return (
    <AnalyticsPanel title={title} className="xl:col-span-2">
      {historical && firstMonth && lastMonth && (
        <div className="-mt-2 mb-3 flex flex-wrap items-center justify-between gap-2 pl-6">
          <p className="text-xs text-muted-foreground">
            {annual
              ? "Elegí un año para ver sus meses"
              : `${formatMonthYear(firstMonth)} – ${formatMonthYear(lastMonth)}`}
          </p>
          {multipleYears && (
            <div
              role="group"
              aria-label="Agrupación del histórico"
              className="flex gap-1 rounded-lg bg-muted p-1"
            >
              {(["month", "year"] as const).map((group) => (
                <button
                  key={group}
                  type="button"
                  aria-pressed={groupBy === group}
                  onClick={() => {
                    hideTooltip();
                    setGroupBy(group);
                  }}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground aria-pressed:bg-card aria-pressed:font-medium aria-pressed:text-foreground"
                >
                  {group === "month" ? "Meses" : "Años"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {showWeekRanges && (
        <p className="-mt-2 mb-3 pl-6 text-xs text-muted-foreground">
          Últimas 8 semanas · de lunes a domingo
        </p>
      )}
      <div className="relative h-56">
        <ParentSize>
          {({ width }) =>
            width > 0 ? (
              <TaskCreationChart
                formatLabel={formatLabel}
                formatDetailLabel={formatDetailLabel}
                height={224}
                items={trend}
                minTickWidth={historical ? (multipleYears && !annual ? 56 : 28) : 0}
                showEmptyBuckets={historical}
                onSelect={
                  annual
                    ? (key) => {
                        hideTooltip();
                        onSelectYear(key);
                      }
                    : undefined
                }
                showWeekRanges={showWeekRanges}
                width={width}
                onTooltip={({ datum, left, top }) =>
                  showTooltip({
                    tooltipData: datum,
                    tooltipLeft: Math.max(
                      0,
                      Math.min(
                        left - trendTooltipWidth / 2,
                        width - trendTooltipWidth,
                      ),
                    ),
                    tooltipTop: top,
                  })
                }
                onTooltipHide={hideTooltip}
              />
            ) : null
          }
        </ParentSize>

        {tooltipOpen && tooltipData && (
          <div
            style={{
              left: tooltipLeft,
              top: tooltipTop,
              width: trendTooltipWidth,
            }}
            role="tooltip"
            className="pointer-events-none absolute z-20 max-w-full -translate-y-full overflow-hidden rounded-lg border border-border bg-popover text-xs leading-tight text-popover-foreground shadow-lg"
          >
            <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5">
              <CalendarDays
                aria-hidden="true"
                className="size-3 shrink-0 text-primary"
              />
              <div className="font-semibold">
                {showWeekRanges
                  ? formatWeekRange(tooltipData.periodKey)
                  : formatDetailLabel(tooltipData.periodKey)}
              </div>
            </div>
            <dl className="space-y-0.5 px-2.5 py-1">
              {trendSources.map(({ key, label, color }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3"
                >
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {label}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatNumber(tooltipData[key])}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex items-center justify-between gap-1.5 border-t border-border bg-primary/5 px-2.5 py-1.5 font-semibold">
              <span>{totalLabel}</span>
              <span className="tabular-nums">
                {formatNumber(tooltipData.count)}{" "}
                {tooltipData.count === 1 ? "tarea" : "tareas"}
              </span>
            </div>
          </div>
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
    </AnalyticsPanel>
  );
}

function groupTrendByYear(months: TaskTrendPoint[]) {
  const years = new Map<string, TaskTrendPoint>();
  for (const month of months) {
    const { periodKey } = analyticsPeriod("year", month.periodKey);
    const year = years.get(periodKey) ?? { periodKey, count: 0, internal: 0, external: 0 };
    year.count += month.count;
    year.internal += month.internal;
    year.external += month.external;
    years.set(periodKey, year);
  }
  return Array.from(years.values());
}
