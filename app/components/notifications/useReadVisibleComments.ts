"use client";
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useReadVisibleComments(taskId: Id<"tasks">) {
  const root = useRef<HTMLElement>(null);
  const rows = useQuery(api.data.commentNotifications.unread, {});
  const mark = useMutation(api.data.commentNotifications.markRead);
  const ids = rows?.find(row => row.taskId === taskId)?.messageIds ?? [];
  const key = ids.join(",");
  useEffect(() => {
    const element = root.current;
    if (!element || !key) return;
    const pending = new Set(key.split(","));
    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = setTimeout(() => {
        if (document.visibilityState !== "visible" || !document.hasFocus()) return;
        const messageIds = [...visible].filter(id => pending.has(id)).slice(0, 100) as Id<"taskMessages">[];
        if (messageIds.length) void mark({ taskId, messageIds }).catch(() => { /* Keep unread on failure; retry on focus or visibility change. */ });
      }, 800);
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.commentId!;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      schedule();
    }, { threshold: 0.5 });
    const observe = () => { element.querySelectorAll<HTMLElement>("[data-comment-id]").forEach(node => { if (pending.has(node.dataset.commentId!)) observer.observe(node); }); };
    const mutation = new MutationObserver(observe);
    mutation.observe(element, { childList: true, subtree: true });
    observe();
    window.addEventListener("focus", schedule); window.addEventListener("blur", schedule); document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); observer.disconnect(); mutation.disconnect(); window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule); document.removeEventListener("visibilitychange", schedule); };
  }, [key, mark, taskId]);
  return root;
}
