"use client";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskMediaProvider } from "../requests/TaskMediaContext";
import { RequestCommentsSection } from "../requests/RequestCommentsSection";
import styles from "../requests/requestsInteractions.module.css";

export function InternalTaskComments({ taskId }: { taskId: Id<"tasks"> }) {
  return <div className={`${styles.interactiveControls} flex min-h-0 min-w-0 flex-col [&>aside]:flex-1`}><TaskMediaProvider taskId={taskId}><RequestCommentsSection taskId={taskId} appearance="classic" /></TaskMediaProvider></div>;
}
