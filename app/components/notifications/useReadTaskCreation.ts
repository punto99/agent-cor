"use client";
import { useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useReadTaskCreation(taskId: Id<"tasks">, visible: boolean) {
  const rows = useQuery(api.data.taskCreationNotifications.unread, {});
  const pending = rows?.some(row => row.taskId === taskId) ?? false;
  const mark = useMutation(api.data.taskCreationNotifications.markRead);
  useEffect(() => {
    if (!visible || !pending) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = setTimeout(() => { void mark({ taskId }).catch(() => { /* Retain unread; retry on focus. */ }); }, 800);
    };
    schedule();
    window.addEventListener("focus", schedule); window.addEventListener("blur", schedule); document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule); document.removeEventListener("visibilitychange", schedule); };
  }, [visible, pending, taskId, mark]);
}
