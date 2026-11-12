import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  addAnalyticsDays,
  analyticsFirstDay,
  analyticsPeriod,
  analyticsPeriodTypes,
  isAnalyticsDay,
  shiftAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsPeriodType,
} from "@/convex/analytics/calendar";

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

export function AnalyticsPeriodPicker({
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
