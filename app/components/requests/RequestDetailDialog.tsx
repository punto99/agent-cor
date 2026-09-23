"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, AlignLeft, X } from "lucide-react";
import type { BoardStage, ExternalRequest } from "./types";
import { useRequestBrief } from "./useRequestBrief";
import { ExpandableDescription } from "../board/ExpandableDescription";
import { BoardDialogScroll } from "../board/BoardDialogScroll";
import { RequestAttachmentsSection } from "./RequestAttachmentsSection";
import { BoardCustomFields } from "../board/BoardCustomFields";
import { TaskMediaProvider } from "./TaskMediaContext";
import { RequestCommentsSection } from "./RequestCommentsSection";
import { BoardDialogMetadata, BoardDialogDeadline } from "../board/BoardDialogMetadata";
import dialogStyles from "../board/BoardDialog.module.css";
import styles from "./requestsInteractions.module.css";

export function RequestDetailDialog({ request, stage, onClose }: {
  request: ExternalRequest; stage: BoardStage; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const brief = useRequestBrief(request.description);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <TaskMediaProvider taskId={request._id}><dialog data-board-theme ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}
      className={`${styles.interactiveControls} ${dialogStyles.surface} fixed inset-0 m-auto max-h-[92dvh] w-[calc(100vw_-_2rem)] max-w-6xl overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/60`}>
      <div className="flex h-[92dvh] max-h-[92dvh] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-semibold">{stage.label}</span>
          <button type="button" autoFocus onClick={onClose} aria-label="Cerrar detalle de tarea" className="rounded-lg p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X className="h-5 w-5" aria-hidden="true" /></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-rows-2 overflow-hidden lg:grid-rows-1 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
          <BoardDialogScroll key={request._id} title={request.title}>
          <div className={dialogStyles.content}>
            <h2 data-board-title id={titleId} className={dialogStyles.title}>{request.title}</h2>
            <BoardDialogMetadata taskId={request._id} />
            <BoardDialogDeadline deadline={request.deadline} status={request.status} />
            <section className={dialogStyles.description} aria-label="Descripción de la tarea">
              <h3><AlignLeft aria-hidden="true" />Descripción</h3>
              <ExpandableDescription key={request._id} html={brief.html || "Sin descripción guardada."} />
            </section>
            {request.threadId && <Link href={`/workspace?threadId=${encodeURIComponent(request.threadId)}`} className="mt-6 inline-flex items-center gap-1 text-xs text-primary hover:underline">Ir al chat <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
            <BoardCustomFields description={request.description} deliverablesCount={request.deliverablesCount} />
            <RequestAttachmentsSection taskId={request._id} />
          </div>
          </BoardDialogScroll>
          <RequestCommentsSection taskId={request._id} />
        </div>
      </div>
    </dialog></TaskMediaProvider>,
    document.body,
  );
}
