import { addAnalyticsDays, analyticsPeriod } from "@/convex/analytics/calendar";

export function sumCounts(items: Array<{ count: number }>) {
  return items.reduce((sum, item) => sum + item.count, 0);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("es").format(value);
}

export function formatDate(value: string) {
  const normalized = value.slice(0, 10);
  const [year, month, day] = normalized.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

export function formatShortDate(value: string) {
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

export function formatShortMonth(value: string) {
  return (
    shortMonthLabels[Number(value.slice(5, 7)) - 1] ?? formatShortDate(value)
  );
}

const monthYearFormatter = new Intl.DateTimeFormat("es-EC", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatMonthYear(value: string) {
  const label = monthYearFormatter.format(new Date(`${value}T00:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const shortWeekDate = new Intl.DateTimeFormat("es-EC", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const longWeekDate = new Intl.DateTimeFormat("es-EC", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

export function formatWeekRange(startDay: string, long = false) {
  const monday = analyticsPeriod("week", startDay).periodKey;
  const endDay = addAnalyticsDays(monday, 6);
  const formatter = long ? longWeekDate : shortWeekDate;
  const start = formatter.format(new Date(`${startDay}T00:00:00Z`));
  const end = formatter.format(new Date(`${endDay}T00:00:00Z`));
  return long ? `Semana del ${start} al ${end}` : `${start} – ${end}`;
}
