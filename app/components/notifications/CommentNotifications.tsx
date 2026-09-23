"use client";
import { useEffect, useId, useRef, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Bell } from "lucide-react";
import Link from "next/link";

export function CommentUnreadBadge({ taskId }: { taskId: Id<"tasks"> }) {
  const rows = useQuery(api.data.commentNotifications.unread, {});
  const count = rows?.find(row => row.taskId === taskId)?.count ?? 0;
  return count ? <span aria-label={`${count} comentarios nuevos`} className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-[#0C66E4] px-1.5 py-0.5 text-[11px] font-semibold text-white">{count > 99 ? "99+" : count}</span> : null;
}

export function CommentNotificationBell() {
  const profile = useQuery(api.data.userAccess.viewerAccessProfile);
  const comments = useQuery(api.data.commentNotifications.unread, {});
  const tasks = useQuery(api.data.taskCreationNotifications.unread, {});
  const [open, setOpen] = useState(false);
  const { results: rows, status, loadMore } = usePaginatedQuery(
    api.data.notificationHistory.list, open ? {} : "skip", { initialNumItems: 5 },
  );
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const total = (comments?.reduce((sum, row) => sum + row.count, 0) ?? 0) + (tasks?.length ?? 0);
  useEffect(() => {
    if (!open) return;
    const click = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  if (!profile?.isAuthenticated || (profile.kind === "external" && !profile.canAccessExternalRequests)) return null;
  return <div ref={root} className="relative">
    <button ref={button} type="button" aria-label={`Notificaciones: ${total} notificaciones nuevas`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className="relative rounded-lg p-2 text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
      <Bell className="h-5 w-5" aria-hidden="true" />
      {total > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[#CA3521] px-1 text-[10px] font-semibold text-white">{total > 99 ? "99+" : total}</span>}
    </button>
    {open && <section id={id} aria-label="Notificaciones" className="absolute right-0 top-full z-[60] mt-2 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-border bg-card text-foreground shadow-xl">
      <h2 className="border-b border-border p-4 text-sm font-semibold">Notificaciones</h2>
      <div className="max-h-[60dvh] overflow-y-auto">
        {status === "LoadingFirstPage" ? <p role="status" className="p-4 text-sm">Cargando…</p> : rows.length ? rows.map(row => <Link key={row.id} href={`${row.external ? "/workspace/requests" : "/workspace/control-panel"}?taskId=${encodeURIComponent(row.taskId)}&tab=${row.kind === "task" ? "task" : "comments"}`} onClick={() => setOpen(false)} className={`block border-b border-border p-4 last:border-0 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${row.read ? "" : "bg-[#E9F2FF] dark:bg-blue-950/30"}`}>
          <span className="flex items-start gap-2 text-sm font-semibold">{!row.read && <span aria-label="No leída" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#0C66E4]" />}{row.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{row.kind === "task" ? `${row.author} creó una nueva tarea` : `${row.author} comentó`}</span>
          {row.context && <span className="mt-1 block text-xs text-muted-foreground">{row.context}</span>}
          <time className="mt-1 block text-xs text-muted-foreground" dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
        </Link>) : <p className="p-5 text-sm text-muted-foreground">No tenés notificaciones.</p>}
        {status === "CanLoadMore" && <button type="button" onClick={() => loadMore(5)} className="w-full p-3 text-sm font-medium text-[#0C66E4] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Cargar más</button>}
        {status === "LoadingMore" && <p role="status" className="p-3 text-center text-sm text-muted-foreground">Cargando…</p>}
      </div>
    </section>}
  </div>;
}
