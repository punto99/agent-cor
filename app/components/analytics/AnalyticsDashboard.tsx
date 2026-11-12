"use client";

import { useEffect } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { analyticsPeriod } from "@/convex/analytics/calendar";
import { LoadingScreen } from "../LoadingScreen";
import { WorkspaceLayout } from "../WorkspaceLayout";
import { AnalyticsOverview } from "./AnalyticsOverview";
import { AnalyticsPeriodPicker } from "./AnalyticsPeriodPicker";
import { useAnalyticsDashboard } from "./useAnalyticsDashboard";

export function AnalyticsDashboard() {
  const router = useRouter();
  const {
    analyticsAccess,
    analytics,
    displayedPeriodType,
    loadingBackfill,
    isUpdatingPeriod,
    period,
    anchor,
    today,
    selectPeriod,
  } = useAnalyticsDashboard();
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
                {isUpdatingPeriod
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

          <AnalyticsOverview
            analytics={analytics}
            periodType={displayedPeriodType}
            loadingBackfill={loadingBackfill}
            onSelectYear={(yearStart) => selectPeriod("year", yearStart)}
          />
        </div>
      </div>
    </WorkspaceLayout>
  );
}
