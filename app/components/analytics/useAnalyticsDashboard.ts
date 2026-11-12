"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import {
  analyticsDay,
  analyticsFirstDay,
  analyticsPeriod,
  analyticsPeriodTypes,
  isAnalyticsDay,
  type AnalyticsPeriodType,
} from "@/convex/analytics/calendar";

export function useAnalyticsDashboard() {
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

  return {
    analyticsAccess,
    analytics,
    displayedPeriodType,
    loadingBackfill,
    isUpdatingPeriod: Boolean(previousPeriod),
    period,
    anchor,
    today,
    selectPeriod,
  };
}
