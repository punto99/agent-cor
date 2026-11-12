import { Suspense } from "react";
import { AnalyticsDashboard } from "@/app/components/analytics/AnalyticsDashboard";
import { LoadingScreen } from "@/app/components/LoadingScreen";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AnalyticsDashboard />
    </Suspense>
  );
}
