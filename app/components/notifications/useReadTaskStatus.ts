"use client";
import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useReadTaskStatus(taskId: Id<"tasks">, visible: boolean) {
  const rows = useQuery(api.data.taskStatusNotifications.unread, {});
  const notificationIds = useMemo(() => rows?.filter(row => row.taskId === taskId).slice(0, 100).map(row => row.id) ?? [], [rows, taskId]);
  const mark = useMutation(api.data.taskStatusNotifications.markRead);
  useEffect(() => {
    if (!visible || !notificationIds.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      // Acknowledge only the events already displayed, never a later status change.
      timer = setTimeout(() => { void mark({ taskId, notificationIds }).catch(() => { /* Retain unread; retry on focus. */ }); }, 800);
    };
    schedule();
    window.addEventListener("focus", schedule); window.addEventListener("blur", schedule); document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule); document.removeEventListener("visibilitychange", schedule); };
  }, [visible, notificationIds, taskId, mark]);
}
