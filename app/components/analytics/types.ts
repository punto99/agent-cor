import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

export type AnalyticsData =
  | Extract<
      FunctionReturnType<typeof api.data.analytics.getDashboard>,
      { canAccess: true }
    >
  | Extract<
      FunctionReturnType<typeof api.data.analytics.getPeriodDashboard>,
      { ready: true }
    >;

export type TaskTrendPoint = {
  periodKey: string;
  count: number;
  internal: number;
  external: number;
};
