import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { SourceId } from "./projection";

const jobs = internal.analytics.jobs;

type Notifier = Pick<ActionCtx, "runMutation" | "scheduler">;

// Call only after a successful operational mutation. A failed job never
// changes the result returned by that mutation.
export async function notifyAnalytics(ctx: Notifier, sourceIds: (SourceId | undefined)[]): Promise<void> {
  try {
    const ids = sourceIds.filter((id): id is SourceId => id !== undefined);
    if (!ids.length) return;
    const jobIds = await ctx.runMutation(jobs.record, { sourceIds: ids });
    for (const jobId of jobIds) {
      try {
        await ctx.scheduler.runAfter(0, jobs.process, { jobId });
      } catch (error) {
        console.error("[analytics] Scheduling failed", jobId, error);
        try {
          await ctx.runMutation(jobs.failure, { jobId, stage: "schedule" });
        } catch (failure) {
          console.error("[analytics] Could not record scheduling failure", jobId, failure);
        }
      }
    }
  } catch (error) {
    console.error("[analytics] Could not record pending sources", sourceIds, error);
  }
}
