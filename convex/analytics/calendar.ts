export const analyticsTimeZone = "America/Guayaquil";
export const analyticsFirstDay = "2026-01-01";
export const analyticsPeriodTypes = ["day", "week", "month", "year", "all"] as const;
export type AnalyticsPeriodType = (typeof analyticsPeriodTypes)[number];
export type AnalyticsPeriod = { periodType: AnalyticsPeriodType; periodKey: string };

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: analyticsTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function analyticsDay(timestamp: number): string {
  const parts = dayFormatter.formatToParts(timestamp);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isAnalyticsDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01") return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function asDate(day: string) {
  return new Date(`${day}T00:00:00Z`);
}

export function addAnalyticsDays(day: string, count: number) {
  const date = asDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function analyticsPeriod(periodType: AnalyticsPeriodType, day: string): AnalyticsPeriod {
  switch (periodType) {
    case "all": return { periodType, periodKey: "all" };
    case "year": return { periodType, periodKey: `${day.slice(0, 4)}-01-01` };
    case "month": return { periodType, periodKey: `${day.slice(0, 7)}-01` };
    case "week": {
      const daysSinceMonday = (asDate(day).getUTCDay() + 6) % 7;
      return { periodType, periodKey: addAnalyticsDays(day, -daysSinceMonday) };
    }
    case "day": return { periodType, periodKey: day };
  }
}

export function shiftAnalyticsPeriod(period: AnalyticsPeriod, count: number): string {
  const { periodType, periodKey } = period;
  if (periodType === "all") return periodKey;
  if (periodType === "day" || periodType === "week") {
    return addAnalyticsDays(periodKey, count * (periodType === "week" ? 7 : 1));
  }
  const date = asDate(periodKey);
  if (periodType === "month") date.setUTCMonth(date.getUTCMonth() + count);
  else date.setUTCFullYear(date.getUTCFullYear() + count);
  return date.toISOString().slice(0, 10);
}

export function analyticsTrendPeriods(period: AnalyticsPeriod, today: string): AnalyticsPeriod[] {
  const { periodType, periodKey } = period;
  if (periodType === "all") {
    const current = analyticsPeriod("week", today);
    return Array.from({ length: 8 }, (_, i) => analyticsPeriod("week", shiftAnalyticsPeriod(current, i - 7)));
  }
  if (periodType === "year") {
    const january = analyticsPeriod("month", periodKey);
    return Array.from({ length: 12 }, (_, i) => analyticsPeriod("month", shiftAnalyticsPeriod(january, i)));
  }
  const end = shiftAnalyticsPeriod(period, 1);
  const days: AnalyticsPeriod[] = [];
  for (let day = periodKey; day < end; day = addAnalyticsDays(day, 1)) {
    days.push(analyticsPeriod("day", day));
  }
  return days;
}
